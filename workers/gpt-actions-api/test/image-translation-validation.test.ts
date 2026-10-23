import { describe, expect, it } from "vitest";
import { validateImageSegments, validateReferenceDimension } from "../src/image-translations";

const segment = { x: 10, y: 20, w: 100, h: 30, text: "译文", bg: "#ffffff", color: "#000000", fontSize: 16 };

describe("image translation validation", () => {
  it("accepts pixel geometry within the model's reference dimensions", () => {
    expect(validateReferenceDimension(640, "referenceWidth")).toBe(640);
    expect(validateImageSegments([segment], 640, 480)).toEqual([segment]);
  });

  it("rejects invalid dimensions and rectangles outside the reference image", () => {
    expect(() => validateReferenceDimension(0, "referenceWidth")).toThrow();
    expect(() => validateReferenceDimension(640.5, "referenceWidth")).toThrow();
    expect(() => validateImageSegments([{ ...segment, x: 600 }], 640, 480)).toThrow();
    expect(() => validateImageSegments([{ ...segment, h: 500 }], 640, 480)).toThrow();
  });

  it("rejects empty text, invalid colors, and more than 200 segments", () => {
    expect(() => validateImageSegments([{ ...segment, text: " " }], 640, 480)).toThrow();
    expect(() => validateImageSegments([{ ...segment, bg: "white" }], 640, 480)).toThrow();
    expect(() => validateImageSegments(Array.from({ length: 201 }, () => segment), 640, 480)).toThrow();
  });
});
