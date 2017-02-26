/** Represents a document that has been made line-by-line accessible. */
export interface Document {
  /** Non-sparse. `pages.length` will return an accurate page count even if
   * some pages do not contain any lines. */
  pages: Page[];
}

/** Represents a page within a paginated document that has been made
 * line-by-line accessible. */
export interface Page {
  /** Non-sparse. `lines.length` will return an accurate line count. */
  lines: Line[];
}

/** Similar to `ClientRect` except it expresses a location within the page upon
 * which an element appears. */
type PageRelativeRect = ClientRect

/** Represents a single line of text and its location within the document. */
export interface Line {
  /** The index of the page upon which the line appears (starting from 0). */
  pageIndex: number;
  /** The location of the line within the page upon which it appears. */
  pageRelativeRect: PageRelativeRect;
  /** The text that appeared within the line. For lines that ended mid-word
   * (e.g. due to hyphenation), the entire word will be grouped with the second
   * line. */
  text: string;
}

/** Traverses `document.body` wrapping every word in its own span, then returns
 * a representation of the processed document.
 *
 * This function is not guaranteed to be safe to run more than once. */
export function processDocument(): Document {
  const spans = transformWordsToSpans();
  const lines = linesOfSpans(spans);
  const pages = pagesOfLines(lines);

  return {
    pages: pages,
  };
}

/** Converts all words in the document to single-word spans and returns the
 * spans. The order of the spans corresponds to the order in which the
 * corresponding text nodes appeared in the original document tree (as would be
 * encountered via a depth-first traversal).
 *
 * Calling this function more than once will result in redundant spans and
 * redundant work. It is best to only call it once and store the result as
 * appropriate. */
function transformWordsToSpans(): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];

  function recurse(element: HTMLElement): void {
    // We convert the node list to a new array because we'll be inserting into
    // the node list as we iterate.
    for(const childNode of Array.from(element.childNodes)) {
      if(childNode instanceof Text) {
        // Split using contiguous whitespace as the separator but also keep the
        // whitespace in the result unchanged.
        const words = childNode.data.split(/(\s+)/g);
        for(const word of words) {
          // Skip leading and trailing empty splits (as you will get if `words`
          // began or ended with whitespace).
          if(word === "") continue;
          // Preserve whitespace.
          if(/^\s+$/.test(word)) {
            const whitespace = document.createTextNode(word);
            element.insertBefore(whitespace, childNode);
            continue;
          }
          // Make a new span containing the word.
          const span = document.createElement("span");
          spans.push(span);
          const text = document.createTextNode(word);
          span.appendChild(text);
          // Inserting each span before the node we're processing is a simple
          // way to add them to the DOM in the correct order.
          element.insertBefore(span, childNode);
        }
        // Remove the original node now that it has been processed and the
        // resulting nodes have been inserted.
        element.removeChild(childNode);
      } else if(childNode instanceof HTMLElement) {
        recurse(childNode);
      }
    }
  }

  recurse(document.body);

  return spans;
}

/** Returns the smallest possible normalized `ClientRect` that encloses both
 * rectangles. Being "normalized" implies left <= right, top <= bottom, and a
 * non-negative width and height. */
function clientRectUnion(a: ClientRect, b: ClientRect): ClientRect {
  const left = Math.min(a.left, a.right, b.left, b.right);
  const right = Math.max(a.left, a.right, b.left, b.right);
  const top = Math.min(a.top, a.bottom, b.top, b.bottom);
  const bottom = Math.max(a.top, a.bottom, b.top, b.bottom);

  return {
    left: left,
    right: right,
    top: top,
    bottom: bottom,
    width: right - left,
    height: bottom - top
  };
}

/** Given a `ClientRect`, returns the index of the page upon which the
 * `ClientRect` begins (starting from page index 0). This procedure takes into
 * account the current horizontal scroll position so page indexes are always
 * relative to the start of the document. */
function pageIndexOfClientRect(rect: ClientRect): number {
  return Math.floor((rect.left + window.pageXOffset) / window.innerWidth);
}

/** Converts a `ClientRect` to a `PageRelativeRect` by taking into account the
 * current page width. */
function pageRelativeRectOfClientRect(rect: ClientRect): PageRelativeRect {
  return {
    left: rect.left % window.innerWidth,
    right: rect.right % window.innerWidth,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

/** Analyze all spans to determine on which line they appear. This is done as a
 * separate step after all the spans have been made to avoid continually forcing
 * layout while nodes are still being inserted. */
function linesOfSpans(spans: HTMLSpanElement[]): Line[] {
  const lines: Line[] = [];
  let currentLineIndex = 0;
  let currentLineSpans: HTMLSpanElement[] = [];
  let currentLineClientRect = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
    width: -Infinity,
    height: -Infinity
  };

  function addCurrentLineToLines() {
    lines[currentLineIndex] = {
      pageIndex: pageIndexOfClientRect(currentLineClientRect),
      pageRelativeRect: pageRelativeRectOfClientRect(currentLineClientRect),
      text: currentLineSpans.map(s => (s.firstChild as Text).data).join(" ")
    }
  }

  function beginNextLine(
    firstSpan: HTMLSpanElement,
    initialClientRect: ClientRect)
  {
    ++currentLineIndex;
    currentLineSpans = [firstSpan];
    currentLineClientRect = initialClientRect;
  }

  function continueLine(span: HTMLSpanElement, clientRectOfSpan: ClientRect) {
    currentLineSpans.push(span);
    currentLineClientRect =
      clientRectUnion(currentLineClientRect, clientRectOfSpan);
  }

  function processSpans() {
    let lastBottom = -Infinity;
    let lastLeft = -Infinity;
    let lastPageIndex = 0;

    for(const span of spans) {
      const rect = span.getBoundingClientRect();
      const onNextPage = pageIndexOfClientRect(rect) > lastPageIndex;
      const newLineIsBeginning =
        rect.left <= lastLeft
        || rect.top >= lastBottom
        || onNextPage;

      if(newLineIsBeginning) {
        addCurrentLineToLines();
        beginNextLine(span, rect);
      } else {
        continueLine(span, rect);
      }

      lastBottom = rect.bottom;
      lastLeft = rect.left;
      if(onNextPage) {
        ++lastPageIndex;
      }
    }
  }

  // Do the actual work.
  processSpans();

  // Add any remaining work-in-progress as the final line.
  if(currentLineSpans !== []) {
    addCurrentLineToLines();
  }

  return lines;
}

/* Given an array of `Line` objects, returns an array of `Page` objects. The
 * index of each `Page` object corresponds to its page index within the
 * document. All pages in the document are represented regardless of whether or
 * not they contain any lines. */
function pagesOfLines(lines: Line[]): Page[] {
  const pages: Page[] = [];

  // Group pages into lines.
  for(const line of lines) {
    if(pages[line.pageIndex] === undefined) {
      pages[line.pageIndex] = {lines: []};
    }
    pages[line.pageIndex].lines.push(line);
  }

  // Ensure our array is non-sparse and includes all pages. This makes use of
  // the result less error-prone. The call to `Math.ceil` is here just in case
  // there is any weirdness with pagination in the browser that results in a
  // fractional number of pages: It /should/ have no effect.
  const totalPages = Math.ceil(document.body.scrollWidth / window.innerWidth);
  for(let i = 0; i < totalPages; ++i) {
    if(pages[i] === undefined) {
      pages[i] = {lines: []};
    }
  }

  return pages;
}
