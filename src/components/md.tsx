import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

export function MD({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm max-w-none prose-headings:font-display prose-strong:text-foreground", className)}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="leading-relaxed my-1.5">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
          code: ({ children }) => <code className="bg-muted px-1 py-0.5 rounded text-[0.85em]">{children}</code>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
