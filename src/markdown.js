import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.use({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(source = "") {
  const rendered = marked.parse(String(source), { async: false });
  return sanitizeHtml(rendered, {
    allowedTags: [
      "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "a", "hr",
    ],
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "nofollow noreferrer noopener" },
      }),
    },
  });
}
