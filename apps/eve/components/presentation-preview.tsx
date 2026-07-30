"use client";

import { Loader } from "@cloudflare/kumo";
import { useEffect, useState } from "react";

import { createAsyncLruCache } from "@/lib/async-lru-cache";

interface SlideElement {
  id: string;
  kind: "image" | "text";
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: "center" | "left" | "right";
  color?: string;
}

interface Slide {
  elements: SlideElement[];
  number: number;
}

const R_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parseXml(source: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("This presentation contains invalid XML.");
  }
  return document;
}

function descendants(element: Element | XMLDocument, localName: string): Element[] {
  return Array.from(element.getElementsByTagName("*")).filter(
    (candidate) => candidate.localName === localName,
  );
}

function firstDescendant(
  element: Element | XMLDocument,
  localName: string,
): Element | undefined {
  return descendants(element, localName)[0];
}

function resolveZipPath(baseFile: string, target: string): string {
  const parts = [...baseFile.split("/").slice(0, -1), ...target.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function relationships(document: XMLDocument, baseFile: string): Map<string, string> {
  return new Map(
    descendants(document, "Relationship").flatMap((relationship) => {
      const id = relationship.getAttribute("Id");
      const target = relationship.getAttribute("Target");
      return id && target ? [[id, resolveZipPath(baseFile, target)] as const] : [];
    }),
  );
}

function numberAttribute(element: Element | undefined, name: string): number | undefined {
  if (element === undefined) return undefined;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : undefined;
}

function geometry(
  element: Element,
  slideWidth: number,
  slideHeight: number,
  fallbackIndex: number,
): Pick<SlideElement, "height" | "width" | "x" | "y"> {
  const transform = firstDescendant(element, "xfrm");
  const offset = transform ? firstDescendant(transform, "off") : undefined;
  const extent = transform ? firstDescendant(transform, "ext") : undefined;
  const x = numberAttribute(offset, "x");
  const y = numberAttribute(offset, "y");
  const width = numberAttribute(extent, "cx");
  const height = numberAttribute(extent, "cy");
  if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
    return {
      x: (x / slideWidth) * 100,
      y: (y / slideHeight) * 100,
      width: (width / slideWidth) * 100,
      height: (height / slideHeight) * 100,
    };
  }
  return {
    x: 7,
    y: Math.min(82, 7 + fallbackIndex * 13),
    width: 86,
    height: 11,
  };
}

function textElement(
  shape: Element,
  index: number,
  slideWidth: number,
  slideHeight: number,
): SlideElement | null {
  const paragraphs = descendants(shape, "p")
    .map((paragraph) =>
      descendants(paragraph, "t")
        .map((node) => node.textContent ?? "")
        .join(""),
    )
    .filter((text) => text.trim().length > 0);
  const value = paragraphs.join("\n").trim();
  if (value.length === 0) return null;

  const runProperties =
    firstDescendant(shape, "rPr") ?? firstDescendant(shape, "defRPr");
  const placeholder = firstDescendant(shape, "ph")?.getAttribute("type");
  const rawFontSize = numberAttribute(runProperties, "sz");
  const fontSize =
    rawFontSize === undefined
      ? placeholder === "title" || placeholder === "ctrTitle"
        ? 30
        : 17
      : Math.max(8, Math.min(48, rawFontSize / 100));
  const alignment = firstDescendant(shape, "pPr")?.getAttribute("algn");
  const colorValue = firstDescendant(runProperties ?? shape, "srgbClr")?.getAttribute("val");

  return {
    id: `text-${index}`,
    kind: "text",
    value,
    ...geometry(shape, slideWidth, slideHeight, index),
    fontSize,
    fontWeight: runProperties?.getAttribute("b") === "1" ? 700 : 400,
    textAlign: alignment === "ctr" ? "center" : alignment === "r" ? "right" : "left",
    color: colorValue && /^[0-9a-f]{6}$/i.test(colorValue) ? `#${colorValue}` : "#111827",
  };
}

function imageMime(pathname: string): string | null {
  const extension = pathname.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
}

async function loadPresentation(
  contentUrl: string,
): Promise<Slide[]> {
  const [response, module] = await Promise.all([
    fetch(contentUrl),
    import("jszip"),
  ]);
  if (!response.ok) throw new Error("Could not load the presentation.");
  const zip = await module.default.loadAsync(await response.arrayBuffer());
  const presentationFile = zip.file("ppt/presentation.xml");
  if (presentationFile === null) throw new Error("This file is not a valid PowerPoint document.");

  const presentation = parseXml(await presentationFile.async("text"));
  const slideSize = firstDescendant(presentation, "sldSz");
  const slideWidth = numberAttribute(slideSize, "cx") ?? 12_192_000;
  const slideHeight = numberAttribute(slideSize, "cy") ?? 6_858_000;
  const presentationRelationshipsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const presentationRelationships =
    presentationRelationshipsFile === null
      ? new Map<string, string>()
      : relationships(
          parseXml(await presentationRelationshipsFile.async("text")),
          "ppt/presentation.xml",
        );
  const orderedSlidePaths = descendants(presentation, "sldId").flatMap((slide) => {
    const relationshipId =
      slide.getAttributeNS(R_NAMESPACE, "id") ?? slide.getAttribute("r:id");
    const path = relationshipId ? presentationRelationships.get(relationshipId) : undefined;
    return path ? [path] : [];
  });
  const fallbackSlidePaths = Object.keys(zip.files)
    .filter((pathname) => /^ppt\/slides\/slide\d+\.xml$/.test(pathname))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/\d+/)?.[0] ?? 0);
      const rightNumber = Number(right.match(/\d+/)?.[0] ?? 0);
      return leftNumber - rightNumber;
    });
  const slidePaths = orderedSlidePaths.length > 0 ? orderedSlidePaths : fallbackSlidePaths;
  const slides = await Promise.all(
    slidePaths.map(async (slidePath, slideIndex): Promise<Slide> => {
      const slideFile = zip.file(slidePath);
      if (slideFile === null) return { elements: [], number: slideIndex + 1 };
      const slide = parseXml(await slideFile.async("text"));
      const fileName = slidePath.split("/").pop();
      const relsPath = fileName
        ? `${slidePath.slice(0, -fileName.length)}_rels/${fileName}.rels`
        : "";
      const relsFile = relsPath ? zip.file(relsPath) : null;
      const slideRelationships =
        relsFile === null
          ? new Map<string, string>()
          : relationships(parseXml(await relsFile.async("text")), slidePath);
      const text = descendants(slide, "sp").flatMap((shape, index) => {
        const parsed = textElement(shape, index, slideWidth, slideHeight);
        return parsed === null ? [] : [parsed];
      });
      const images = await Promise.all(
        descendants(slide, "pic").map(async (picture, index): Promise<SlideElement | null> => {
          const embed =
            firstDescendant(picture, "blip")?.getAttributeNS(R_NAMESPACE, "embed") ??
            firstDescendant(picture, "blip")?.getAttribute("r:embed");
          const mediaPath = embed ? slideRelationships.get(embed) : undefined;
          const mime = mediaPath ? imageMime(mediaPath) : null;
          const mediaFile = mediaPath && mime ? zip.file(mediaPath) : null;
          if (mediaFile === null || mime === null) return null;
          return {
            id: `image-${index}`,
            kind: "image",
            // Data URLs stay valid for the lifetime of the cached parsed
            // preview and require no object-URL cleanup when React switches
            // between documents.
            value: `data:${mime};base64,${await mediaFile.async("base64")}`,
            ...geometry(picture, slideWidth, slideHeight, text.length + index),
          };
        }),
      );
      return {
        elements: [...images.filter((image): image is SlideElement => image !== null), ...text],
        number: slideIndex + 1,
      };
    }),
  );
  if (slides.length === 0) throw new Error("This presentation has no slides.");
  return slides;
}

const presentations = createAsyncLruCache<string, Slide[]>({ maxEntries: 6 });

export function preloadPresentation(contentUrl: string): Promise<Slide[]> {
  return presentations.get(contentUrl, () => loadPresentation(contentUrl));
}

export function PresentationPreview({
  contentUrl,
  onSelection,
}: {
  contentUrl: string;
  onSelection?: (selection: unknown) => void;
}) {
  const cached = presentations.peek(contentUrl);
  const [slides, setSlides] = useState<Slide[]>(() => cached ?? []);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const immediate = presentations.peek(contentUrl);
    setSlides(immediate ?? []);
    setLoading(immediate === undefined);
    setError(null);
    void preloadPresentation(contentUrl)
      .then((next) => {
        if (!cancelled) setSlides(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not render the presentation.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  if (error !== null) {
    return <p className="p-4 text-sm text-kumo-danger">{error}</p>;
  }
  return (
    <div className="relative min-h-64 flex-1 overflow-auto bg-kumo-recessed p-3">
      {loading ? (
        <div className="flex min-h-64 items-center justify-center text-kumo-subtle">
          <Loader size={20} />
        </div>
      ) : (
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          {slides.map((slide) => (
            <div
              key={slide.number}
              className="group"
              role="button"
              tabIndex={0}
              aria-label={`Select slide ${slide.number}`}
              onClick={() => onSelection?.({ type: "slide", slide: slide.number })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelection?.({ type: "slide", slide: slide.number });
                }
              }}
            >
              <div className="mb-1 text-xs font-medium text-kumo-subtle">
                Slide {slide.number}
              </div>
              <div className="relative aspect-video overflow-hidden rounded-lg border border-kumo-line bg-white shadow-sm outline-none transition group-focus-within:ring-2 group-focus-within:ring-kumo-accent">
                {slide.elements.map((element) => (
                  <div
                    key={element.id}
                    className="absolute overflow-hidden whitespace-pre-wrap"
                    style={{
                      left: `${element.x}%`,
                      top: `${element.y}%`,
                      width: `${element.width}%`,
                      height: `${element.height}%`,
                      color: element.color,
                      fontSize: element.fontSize
                        ? `clamp(8px, ${element.fontSize / 22}vw, ${element.fontSize}px)`
                        : undefined,
                      fontWeight: element.fontWeight,
                      textAlign: element.textAlign,
                    }}
                  >
                    {element.kind === "image" ? (
                      // Blob URLs are created only from raster image files inside this PPTX.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={element.value}
                        alt=""
                        className="size-full object-contain"
                        draggable={false}
                      />
                    ) : (
                      element.value
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
