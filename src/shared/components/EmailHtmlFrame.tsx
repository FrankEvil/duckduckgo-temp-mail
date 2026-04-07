import { useEffect, useRef, useState } from "react";

export type MailThemeMode = "dark" | "light";

export function extractMailbox(value: string) {
  const bracketMatch = value.match(/<([^>]+)>/);

  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch?.[0] || value.trim();
}

export function normalizePlainTextContent(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeEmailResourceUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (/^\/\//.test(trimmed)) {
    return `https:${trimmed}`;
  }

  if (
    /^(https?:|data:|blob:|mailto:|tel:|#)/i.test(trimmed) ||
    /^cid:/i.test(trimmed)
  ) {
    return trimmed;
  }

  return "";
}

function normalizeInlineResourceId(value: string) {
  return value.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
}

function normalizeSrcSet(value: string) {
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [urlPart, descriptor = ""] = candidate.split(/\s+/, 2);
      const normalizedUrl = normalizeEmailResourceUrl(urlPart || "");
      return normalizedUrl ? `${normalizedUrl}${descriptor ? ` ${descriptor}` : ""}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function buildEmailHtmlDocument(
  html: string,
  theme: MailThemeMode,
  inlineResourceMap: Record<string, string>
) {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");

  for (const element of Array.from(document.querySelectorAll("script, iframe, object, embed"))) {
    element.remove();
  }

  for (const metaRefresh of Array.from(document.querySelectorAll('meta[http-equiv="refresh" i]'))) {
    metaRefresh.remove();
  }

  for (const formElement of Array.from(
    document.querySelectorAll("form, button, input, select, textarea")
  )) {
    formElement.replaceWith(...Array.from(formElement.childNodes));
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];

  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element);
  }

  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value.trim();

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (attributeName === "href") {
        if (/^cid:/i.test(attributeValue)) {
          const inlineResource = inlineResourceMap[normalizeInlineResourceId(attributeValue)];
          if (!inlineResource) {
            element.removeAttribute(attribute.name);
            continue;
          }

          element.setAttribute(attribute.name, inlineResource);
          continue;
        }

        const normalizedHref = normalizeEmailResourceUrl(attributeValue);
        if (!normalizedHref) {
          element.removeAttribute(attribute.name);
          continue;
        }

        element.setAttribute(attribute.name, normalizedHref);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
        continue;
      }

      if (attributeName === "src" || attributeName === "poster" || attributeName === "background") {
        if (/^cid:/i.test(attributeValue)) {
          const inlineResource = inlineResourceMap[normalizeInlineResourceId(attributeValue)];
          if (!inlineResource) {
            element.removeAttribute(attribute.name);
            continue;
          }

          element.setAttribute(attribute.name, inlineResource);
          continue;
        }

        const normalizedSrc = normalizeEmailResourceUrl(attributeValue);
        if (!normalizedSrc) {
          element.removeAttribute(attribute.name);
          continue;
        }

        element.setAttribute(attribute.name, normalizedSrc);
        continue;
      }

      if (attributeName === "srcset") {
        const normalizedSrcSet = normalizeSrcSet(attributeValue);
        if (!normalizedSrcSet) {
          element.removeAttribute(attribute.name);
          continue;
        }

        element.setAttribute(attribute.name, normalizedSrcSet);
        continue;
      }

      if (
        element.tagName.toLowerCase() === "img" &&
        !element.getAttribute("src") &&
        ["data-src", "data-original", "data-original-src", "data-lazy-src"].includes(attributeName)
      ) {
        const normalizedLazySrc = normalizeEmailResourceUrl(attributeValue);
        if (normalizedLazySrc) {
          element.setAttribute("src", normalizedLazySrc);
        }
      }
    }
  }

  const head = document.head.innerHTML.trim();
  const body = document.body.innerHTML.trim();
  const htmlClassName = theme === "dark" ? "email-theme-dark" : "email-theme-light";
  const bodyClassName = theme === "dark" ? "email-theme-dark-adapt" : "email-theme-light-adapt";

  return `<!doctype html>
<html class="${htmlClassName}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
      }

      html.email-theme-light {
        color-scheme: light;
        background: #ffffff;
      }

      html.email-theme-dark {
        color-scheme: light;
        background: #ffffff;
      }
    </style>
    ${head}
    <style>
      body {
        overflow-wrap: break-word;
      }

      body.email-theme-light-adapt,
      body.email-theme-dark-adapt {
        background: #ffffff;
      }

      img {
        max-width: 100% !important;
        height: auto !important;
        display: block;
      }

      table {
        max-width: 100% !important;
      }
    </style>
  </head>
  <body class="${bodyClassName}">${body}</body>
</html>`;
}

type EmailHtmlFrameProps = {
  html: string;
  title: string;
  theme: MailThemeMode;
  inlineResourceMap?: Record<string, string>;
  className?: string;
};

export function EmailHtmlFrame({
  html,
  title,
  theme,
  inlineResourceMap = {},
  className
}: EmailHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState(320);
  const srcDoc = buildEmailHtmlDocument(html, theme, inlineResourceMap);

  function syncFrameHeight() {
    const iframe = iframeRef.current;
    const document = iframe?.contentDocument;
    const body = document?.body;
    const root = document?.documentElement;

    if (!iframe || !body || !root) {
      return;
    }

    const nextHeight = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      root.scrollHeight,
      root.offsetHeight,
      160
    );

    setFrameHeight(nextHeight);
  }

  function handleLoad() {
    syncFrameHeight();

    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    for (const image of Array.from(document.images)) {
      if (image.complete) {
        continue;
      }

      image.addEventListener("load", syncFrameHeight, { once: true });
      image.addEventListener("error", syncFrameHeight, { once: true });
    }

    window.setTimeout(syncFrameHeight, 60);
    window.setTimeout(syncFrameHeight, 220);
    window.setTimeout(syncFrameHeight, 600);
  }

  useEffect(() => {
    setFrameHeight(320);
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      className={className}
      title={title}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      loading="lazy"
      srcDoc={srcDoc}
      style={{ height: `${frameHeight}px` }}
      onLoad={handleLoad}
    />
  );
}
