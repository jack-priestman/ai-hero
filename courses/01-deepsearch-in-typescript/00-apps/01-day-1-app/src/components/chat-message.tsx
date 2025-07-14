import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { Message } from "ai";

export type MessagePart = NonNullable<Message["parts"]>[number];

interface ChatMessageProps {
  parts: MessagePart[];
  role: string;
  userName: string;
}

const components: Components = {
  // Override default elements with custom styling
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-4 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-4 list-disc pl-4">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-4 list-decimal pl-4">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="mb-1">{children}</li>
  ),
  code: ({
    className,
    children,
    ...props
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => (
    <code className={`${className ?? ""}`} {...props}>
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="mb-4 overflow-x-auto rounded-lg bg-gray-700 p-4">
      {children}
    </pre>
  ),
  a: ({ children, ...props }: { children?: React.ReactNode }) => (
    <a
      className="text-blue-400 underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
};

const Markdown = ({ children }: { children: string }) => {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
};

function renderPart(part: MessagePart, idx: number) {
  if (part.type === "text") {
    return (
      <div key={idx} title="TextUIPart">
        <Markdown>{part.text}</Markdown>
      </div>
    );
  }
  if (part.type === "tool-invocation") {
    const { toolInvocation } = part;
    return (
      <div
        key={idx}
        className="my-2 rounded bg-gray-700 p-2"
        title="ToolInvocationUIPart (hover for details)"
      >
        <div className="font-mono text-xs text-gray-300">
          <strong>Tool Call:</strong> {toolInvocation.toolName}
          <br />
          <span className="text-gray-400">State:</span> {toolInvocation.state}
          <br />
          <span className="text-gray-400">Args:</span>{" "}
          {JSON.stringify(toolInvocation.args)}
          {"result" in toolInvocation && toolInvocation.result && (
            <>
              <br />
              <span className="text-gray-400">Result:</span>{" "}
              {JSON.stringify(toolInvocation.result)}
            </>
          )}
        </div>
      </div>
    );
  }
  // Encourage user to hover for more info on other part types
  return (
    <div
      key={idx}
      className="italic text-gray-400"
      title={`MessagePart type: ${part.type} (hover for details)`}
    >
      [MessagePart: {part.type}]
    </div>
  );
}

export const ChatMessage = ({ parts, role, userName }: ChatMessageProps) => {
  const isAI = role === "assistant";

  return (
    <div className="mb-6">
      <div
        className={`rounded-lg p-4 ${
          isAI ? "bg-gray-800 text-gray-300" : "bg-gray-900 text-gray-300"
        }`}
      >
        <p className="mb-2 text-sm font-semibold text-gray-400">
          {isAI ? "AI" : userName}
        </p>
        <div className="prose prose-invert max-w-none">
          {parts && parts.length > 0 ? (
            parts.map((part, idx) => renderPart(part, idx))
          ) : (
            <span className="italic text-gray-400">[No message parts]</span>
          )}
        </div>
      </div>
    </div>
  );
};
