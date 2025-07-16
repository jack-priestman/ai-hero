import type { Message } from "ai";
import {
  streamText,
  createDataStreamResponse,
  appendResponseMessages,
} from "ai";
import { model } from "~/model";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";
import { bulkCrawlWebsites, type CrawlErrorResponse } from "~/scraper";
import { cacheWithRedis } from "~/server/redis/redis";
import { z } from "zod";
import { upsertChat } from "~/server/db/queries";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { chats } from "~/server/db/schema";
import { Langfuse } from "langfuse";
import { env } from "~/env";

export const maxDuration = 60;

// Cache the scrapePages functionality
const cachedScrapePages = cacheWithRedis(
  "scrapePages",
  async (urls: string[]) => {
    return bulkCrawlWebsites({ urls });
  },
);

// Helper function to format crawl results
const formatCrawlResult = (r: { url: string; result: any }) => ({
  url: r.url,
  success: r.result.success,
  content: r.result.success ? r.result.data : undefined,
  error: r.result.success ? undefined : r.result.error,
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
    chatId?: string;
  };

  const { messages, chatId } = body;

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  // If no chatId is provided, create a new chat with the user's message
  let currentChatId = chatId;
  if (!currentChatId) {
    const newChatId = crypto.randomUUID();
    await upsertChat({
      userId: session.user.id,
      chatId: newChatId,
      title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
      messages: messages, // Only save the user's message initially
    });
    currentChatId = newChatId;
  } else {
    // Verify the chat belongs to the user
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, currentChatId),
    });
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  // Langfuse tracing enrichment setup

  const langfuse = new Langfuse({
    environment: env.NODE_ENV,
  });

  const trace = langfuse.trace({
    sessionId: currentChatId,
    name: "chat",
    userId: session.user.id,
  });

  return createDataStreamResponse({
    execute: async (dataStream) => {
      // If this is a new chat, send the chat ID to the frontend
      if (!chatId) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: currentChatId,
        });
      }

      const result = streamText({
        model,
        messages,
        maxSteps: 10,
        experimental_telemetry: {
          isEnabled: true,
          functionId: `agent`,
          metadata: {
            langfuseTraceId: trace.id,
          },
        },
        system: `You are a helpful AI assistant with access to real-time web search capabilities and web page scraping. When answering questions:

1. First, search the web for up-to-date information when relevant using the searchWeb tool
2. Then, ALWAYS use the scrapePages tool to get the complete text content from 4-6 of the most relevant and diverse URLs found in your search
3. When selecting URLs to scrape, prioritize:
   - Different types of sources (news sites, official websites, academic sources, forums, blogs)
   - Recent and authoritative content
   - Diverse perspectives on the topic
   - Primary sources when available
4. Use scrapePages for:
   - Getting detailed information from specific articles or pages
   - Obtaining full context beyond search snippets
   - Analyzing complete content of pages
   - Providing comprehensive information from multiple sources
5. ALWAYS format URLs as markdown links using the format [title](url)
6. Be thorough but concise in your responses
7. If you're unsure about something, search the web to verify and then scrape 4-6 relevant pages
8. When providing information, always include the source where you found it using markdown links
9. Never include raw URLs - always use markdown link format
10. Synthesize information from multiple scraped sources to provide a well-rounded answer

Remember: Search first with searchWeb, then scrape 4-6 diverse and relevant pages with scrapePages to provide comprehensive and accurate information from multiple perspectives.`,
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
          scrapePages: {
            parameters: z.object({
              urls: z
                .array(z.string())
                .describe("Array of URLs to scrape for full content"),
            }),
            execute: async ({ urls }) => {
              const result = await cachedScrapePages(urls);

              // Handle the overall result based on success/failure
              if (result.success) {
                // All scraping was successful
                return {
                  success: true,
                  results: result.results.map(formatCrawlResult),
                  summary: `Successfully scraped ${result.results.length} pages`,
                };
              } else {
                // Some or all scraping failed
                const successfulResults = result.results.filter(
                  (r) => r.result.success,
                );
                const failedResults = result.results.filter(
                  (r) => !r.result.success,
                );

                return {
                  success: false,
                  results: result.results.map(formatCrawlResult),
                  summary: `Scraped ${successfulResults.length}/${result.results.length} pages successfully`,
                  error: result.error,
                  failedUrls: failedResults.map((r) => r.url),
                };
              }
            },
          },
        },
        onFinish: async ({ response }) => {
          // Merge the existing messages with the response messages
          const updatedMessages = appendResponseMessages({
            messages,
            responseMessages: response.messages,
          });

          const lastMessage = messages[messages.length - 1];
          if (!lastMessage) {
            return;
          }

          // Save the complete chat history
          await upsertChat({
            userId: session.user.id,
            chatId: currentChatId,
            title: lastMessage.content.slice(0, 50) + "...",
            messages: updatedMessages,
          });

          // flush the Langfuse trace
          await langfuse.flushAsync();
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occurred!";
    },
  });
}
