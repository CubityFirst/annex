import { describe, it, expect } from "vitest";
import { parseImageAttrs, styleFromAttrs, parseInlineStyle } from "./imageAttrs";

describe("parseInlineStyle (W-L6 shared helper)", () => {
  it("parses the declarations styleFromAttrs emits", () => {
    expect(parseInlineStyle("width: 320px; height: 200px")).toEqual({
      width: "320px",
      height: "200px",
    });
  });

  it("parses margin/display alignment declarations", () => {
    expect(parseInlineStyle("display: block; margin-left: auto; margin-right: auto")).toEqual({
      display: "block",
      marginLeft: "auto",
      marginRight: "auto",
    });
  });

  it("ignores unknown properties and malformed declarations", () => {
    expect(parseInlineStyle("color: red; ; width: 10px; :bad")).toEqual({ width: "10px" });
  });

  it("round-trips styleFromAttrs output", () => {
    const style = styleFromAttrs(parseImageAttrs("width=320 align=center"));
    expect(style).toBeTruthy();
    const obj = parseInlineStyle(style!);
    expect(obj.width).toBe("320px");
    expect(obj.display).toBe("block");
    expect(obj.marginLeft).toBe("auto");
    expect(obj.marginRight).toBe("auto");
  });
});
