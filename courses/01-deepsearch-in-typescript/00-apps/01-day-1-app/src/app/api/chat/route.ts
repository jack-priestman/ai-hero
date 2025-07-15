import type { Message } from "ai";
import {
  streamText,
  createDataStreamResponse,
  appendResponseMessages,
} from "ai";
import { z } from "zod";
import { searchSerper } from "~/serper";
import { model } from "~/model";
import { auth } from "~/server/auth";

import { db } from "~/server/db";
import { chats, messages as messagesTable } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { upsertChat } from "~/server/db/chat-helpers";

export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as { messages: Array<Message> };

  const {
    messages: incomingMessages,
    chatId,
  }: { messages: any[]; chatId?: string } = body;
  const userId = session.user.id;

  // 1. If no chatId, create a new chat before streaming
  let chat_id: string | undefined = chatId;
  let isNewChat = false;
  if (!chat_id) {
    chat_id = nanoid();
    isNewChat = true;
    await upsertChat({
      id: chat_id,
      userId,
      title: incomingMessages[0]?.content?.slice(0, 40) || "New Chat",
      createdAt: new Date(),
    });
    // Optionally, insert the first user message here as well
  }

  return createDataStreamResponse({
    execute: async (dataStream) => {
      // If a new chat was created, send the chatId to the frontend
      if (isNewChat && chat_id) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: chat_id,
        });
      }

      const { messages } = body;

      const result = streamText({
        model,
        messages,
        system: `You are an AI assistant with access to a web search tool. Always use the searchWeb tool to answer questions, and always cite your sources with inline markdown links. If you do not know the answer, use the search tool to find it.`,
        maxSteps: 10,
        tools: {
          searchWeb: {
            parameters: z.object({
              query: z.string().describe("The query to search the web for"),
            }),
            execute: async ({ query }, { abortSignal }) => {
              const results = await searchSerper(
                { q: query, num: 10 },
                abortSignal,
              );
              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
              }));
            },
          },
        },
        onFinish: async ({ response }) => {
          const responseMessages = response.messages;
          const updatedMessages = appendResponseMessages({
            messages: incomingMessages,
            responseMessages,
          });

          // 3. Replace all messages in the DB for this chat
          await db
            .delete(messagesTable)
            .where(eq(messagesTable.chatId, chat_id));
          await db.insert(messagesTable).values(
            updatedMessages.map((msg, i) => ({
              id: msg.id || nanoid(),
              chatId: chat_id,
              role: msg.role,
              parts: msg.parts,
              order: i,
              createdAt: new Date(),
            })),
          );

          // Optionally, update chat title if needed
        },
      });
      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occured!";
    },
  });
}
