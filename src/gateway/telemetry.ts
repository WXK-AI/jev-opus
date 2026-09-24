import { StringDecoder } from 'node:string_decoder';
import type { JournalUsage } from './journal.ts';

/** Observe protocol events without changing the forwarded bytes or retaining content. */
export class ResponseTelemetry {
  readonly usage: JournalUsage = {};
  responseId?: string;
  error?: string;
  complete = false;
  usageComplete = false;
  private buffer = '';
  private dropping = false;
  private readonly decoder = new StringDecoder('utf8');
  private readonly contentType: string;
  private readonly onText: () => void;
  private readonly onTool: (id: string) => void;
  private readonly cap = 1024 * 1024;

  constructor(contentType: string, onTool: (id: string) => void = () => {}, onText: () => void = () => {}) {
    this.contentType = contentType;
    this.onTool = onTool;
    this.onText = onText;
  }

  push(chunk: Buffer): void {
    // Slice large chunks too: one upstream chunk cannot defeat the memory bound.
    for (let i = 0; i < chunk.length; i += 16384) this.consume(this.decoder.write(chunk.subarray(i, i + 16384)));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (this.contentType.includes('json') && !this.dropping) {
      try {
        const message = JSON.parse(this.buffer);
        this.message(message);
        this.complete = message?.type === 'message' && typeof message.stop_reason === 'string';
        if (message?.type === 'error') this.error = 'provider_error';
        this.usageComplete = this.complete && typeof message?.usage?.output_tokens === 'number';
      } catch { /* incomplete JSON is not a completed response */ }
    }
    this.buffer = '';
  }

  private consume(text: string): void {
    if (!this.contentType.includes('text/event-stream')) {
      if (!this.dropping) {
        this.buffer += text;
        if (this.buffer.length > this.cap) { this.buffer = ''; this.dropping = true; }
      }
      return;
    }
    this.buffer += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      if (!this.dropping && frame.length <= this.cap) this.frame(frame);
      this.dropping = false;
    }
    if (this.buffer.length > this.cap) {
      this.buffer = this.buffer.slice(-3); // preserve a split CRLF delimiter
      this.dropping = true;
    }
  }

  private frame(frame: string): void {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    try {
      const e = JSON.parse(data);
      if (e?.type === 'message_start') this.message(e.message);
      if (e?.type === 'message_delta') {
        this.merge(e.usage);
        if (typeof e.delta?.stop_reason === 'string') this.usage.stopReason = e.delta.stop_reason;
        if (typeof e.usage?.output_tokens === 'number') this.usageComplete = true;
      }
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string' && e.delta.text.trim()) this.onText();
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && e.content_block.text?.trim()) this.onText();
      if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use' && typeof e.content_block.id === 'string') this.onTool(e.content_block.id);
      if (e?.type === 'message_stop') this.complete = true;
      if (e?.type === 'error') {
        // Store a code, never the provider's arbitrary error text.
        this.error = typeof e.error?.type === 'string' && /^[\w-]{1,80}$/.test(e.error.type) ? e.error.type : 'provider_error';
      }
    } catch { /* unknown/oversize content cannot mutate protocol state */ }
  }

  private message(m: any): void {
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'string') this.responseId = m.id;
    if (typeof m.model === 'string') this.usage.model = m.model;
    if (typeof m.stop_reason === 'string') this.usage.stopReason = m.stop_reason;
    this.merge(m.usage);
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) this.onText();
      if (b?.type === 'tool_use' && typeof b.id === 'string') this.onTool(b.id);
    }
  }

  private merge(raw: any): void {
    if (!raw || typeof raw !== 'object') return;
    const fields = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadInputTokens', cache_creation_input_tokens: 'cacheCreationInputTokens' } as const;
    for (const [from, to] of Object.entries(fields)) {
      if (typeof raw[from] === 'number' && Number.isFinite(raw[from]) && raw[from] >= 0) this.usage[to] = raw[from];
    }
  }
}
