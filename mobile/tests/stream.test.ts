import { StreamReader } from "../src/stream";
import {
  amountToQuota,
  quotaAmount,
  readConversations,
  saveConversations,
} from "../src/api";

describe("stream transport", () => {
  it("preserves multibyte text split at every byte and CRLF boundaries", () => {
    const update = vi.fn();
    const reader = new StreamReader(update);
    const data = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好🌱"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    for (const byte of data) reader.push(new Uint8Array([byte]));
    reader.finish();
    expect(update).toHaveBeenLastCalledWith("你好🌱", "");
  });
  it("retains partial output but rejects a truncated stream", () => {
    const update = vi.fn();
    const reader = new StreamReader(update);
    reader.push(
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n',
      ),
    );
    expect(() => reader.finish()).toThrow("提前结束");
    expect(update).toHaveBeenLastCalledWith("部分内容", "");
  });
  it("surfaces error events without turning them into success", () => {
    const reader = new StreamReader(vi.fn());
    expect(() =>
      reader.push(
        new TextEncoder().encode('data: {"error":{"message":"额度不足"}}\n\n'),
      ),
    ).toThrow("额度不足");
  });
  it("supports multiline data, reasoning and final event without newline", () => {
    const update = vi.fn();
    const reader = new StreamReader(update);
    reader.push(
      new TextEncoder().encode(
        'data: {"choices":\ndata: [{"delta":{"reasoning_content":"推理"}}]}\n\ndata: {"choices":[{"delta":{"content":"结果"},"finish_reason":"stop"}]}',
      ),
    );
    reader.finish();
    expect(update).toHaveBeenLastCalledWith("结果", "推理");
  });
});
describe("quota and account isolation", () => {
  beforeEach(() => localStorage.clear());
  it("uses server quota units and rejects unavailable units or invalid amounts", () => {
    expect(amountToQuota("0.125", 500000)).toBe(62500);
    expect(quotaAmount(62500, 500000)).toBe("$0.125");
    for (const raw of ["", "-1", "Infinity", "1e4", "1.1234567"])
      expect(() => amountToQuota(raw, 500000)).toThrow();
    expect(() => amountToQuota("1", 0)).toThrow();
    expect(quotaAmount(100, 0)).toBe("—");
  });
  it("never shows another account's conversations and tolerates corrupt storage", () => {
    saveConversations(1, [
      {
        id: "a",
        title: "私有",
        group: "default",
        model: "a",
        updatedAt: 1,
        messages: [],
      },
    ]);
    expect(readConversations(2)).toEqual([]);
    expect(readConversations(1)).toHaveLength(1);
    localStorage.setItem("yuanheng-mobile-chats-v1:1", "{broken");
    expect(readConversations(1)).toEqual([]);
  });
});
