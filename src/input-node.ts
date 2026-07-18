import { parser } from "stream-json/parser.js";
import type { Token } from "stream-json/core/parser.js";
import { fun, getManyValues, none } from "stream-chain/core";
import type { TokenParser } from "./input.js";

export const parseNodeJsonTokens: TokenParser = async function* (chunks, options) {
  const tokenize = fun(parser({
    jsonStreaming: options.jsonStreaming,
    packValues: true,
    streamValues: false,
  }));
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw options.signal.reason;
    const tokens = getManyValues(await tokenize(chunk as never)) as Token[];
    if (tokens.length > 0) yield tokens;
  }
  const finalTokens = getManyValues(await tokenize(none as never)) as Token[];
  if (finalTokens.length > 0) yield finalTokens;
};
