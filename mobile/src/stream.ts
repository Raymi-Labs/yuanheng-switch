/** Incremental SSE parser: UTF-8, CRLF, multi-line data, explicit termination. */
export class StreamReader {
  private decoder = new TextDecoder();
  private buffer = "";
  private lines: string[] = [];
  private done = false;
  private completed = false;
  private text = "";
  private reasoning = "";
  constructor(private update: (text: string, reasoning: string) => void) {}
  push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > 1024 * 1024) throw new Error("流式响应片段过大");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line === "") this.event();
      else if (line.startsWith("data:"))
        this.lines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  private event() {
    if (!this.lines.length) return;
    const data = this.lines.join("\n");
    this.lines = [];
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    if (this.done) return;
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("收到无法解析的回复，已保留此前内容");
    }
    if (value.error)
      throw new Error(
        typeof value.error.message === "string"
          ? value.error.message.slice(0, 300)
          : "模型返回错误",
      );
    const choice = value.choices?.[0];
    if (choice?.finish_reason) this.completed = true;
    if (typeof choice?.delta?.content === "string")
      this.text += choice.delta.content;
    if (typeof choice?.delta?.reasoning_content === "string")
      this.reasoning += choice.delta.reasoning_content;
    this.update(this.text, this.reasoning);
  }
  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.startsWith("data:"))
      this.lines.push(this.buffer.slice(5).trimStart().replace(/\r$/, ""));
    this.buffer = "";
    this.event();
    if (!this.done && !this.completed)
      throw new Error("连接提前结束，已收到的回复已保留");
    if (!this.text && !this.reasoning)
      throw new Error("模型没有返回内容，请查看用量后再决定是否重试");
  }
}
