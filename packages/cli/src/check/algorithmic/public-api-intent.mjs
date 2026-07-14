export const publicApiIntentSections = Object.freeze([
  "Public exports",
  "Experimental exports",
  "Deprecated exports",
]);

export const allApiIntentSections = Object.freeze([
  ...publicApiIntentSections,
  "Internal-only exports",
]);

const headingPattern = /^## (.+)$/u;
const intentPattern = /^- `([^\s`:]+):([^\s`]+)`(?: - .+)?$/u;
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const rawHtmlPattern = /^ {0,3}</u;
const internalOnlySentinel = "Any package file or symbol not listed above.";

const openingFence = (line) => {
  const match = fencePattern.exec(line);
  if (match === null) return undefined;
  const marker = match[1];
  if (marker[0] === "`" && match[2].includes("`")) return undefined;
  return { marker: marker[0], length: marker.length };
};

const closesFence = (line, fence) => {
  const match = fencePattern.exec(line);
  return (
    match !== null &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length &&
    match[2].trim() === ""
  );
};

export const parseApiIntentSource = ({ source, sections, file = "<api-intent>" }) => {
  const normalizedSource = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const acceptedSections = new Set(sections);
  const sectionRecords = [];
  const seenSections = new Set();
  const failures = [];
  let current;
  let fence;
  let htmlComment = false;

  const invalidateCurrent = (line, message) => {
    if (current !== undefined) current.valid = false;
    failures.push(`${file}:${line}: ${message}`);
  };

  for (const [index, line] of normalizedSource.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    if (htmlComment) {
      if (line.includes("-->")) htmlComment = false;
      continue;
    }

    const commentStart = line.indexOf("<!--");
    if (commentStart !== -1) {
      if (current !== undefined) {
        invalidateCurrent(
          lineNumber,
          `${current.section} accepts only explicit API intent list entries or its empty sentinel`,
        );
      }
      htmlComment = line.indexOf("-->", commentStart + 4) === -1;
      continue;
    }

    const nextFence = openingFence(line);
    if (nextFence !== undefined) {
      if (current !== undefined) {
        invalidateCurrent(
          lineNumber,
          `${current.section} accepts only explicit API intent list entries or its empty sentinel`,
        );
      }
      fence = nextFence;
      continue;
    }

    if (rawHtmlPattern.test(line)) {
      invalidateCurrent(lineNumber, "raw HTML is outside the API intent grammar");
      continue;
    }

    const heading = headingPattern.exec(line);
    if (heading !== null) {
      const section = heading[1];
      if (!acceptedSections.has(section)) {
        current = undefined;
        continue;
      }
      const duplicate = seenSections.has(section);
      current = { section, valid: !duplicate, entries: [], emptyLine: undefined };
      sectionRecords.push(current);
      if (duplicate) {
        failures.push(`${file}:${lineNumber}: duplicate governed API intent section ${section}`);
      }
      seenSections.add(section);
      continue;
    }

    if (current === undefined || line.trim() === "") continue;

    const intent = intentPattern.exec(line);
    if (intent !== null) {
      if (current.emptyLine !== undefined) {
        invalidateCurrent(
          lineNumber,
          `${current.section} cannot combine API intent entries with its empty sentinel at line ${current.emptyLine}`,
        );
      }
      const [, subpath, symbol] = intent;
      current.entries.push({
        name: `${subpath}:${symbol}`,
        subpath,
        symbol,
        section: current.section,
        line: lineNumber,
      });
      continue;
    }

    const isEmptySentinel =
      line === "None." ||
      (current.section === "Internal-only exports" && line === internalOnlySentinel);
    if (isEmptySentinel) {
      if (current.emptyLine !== undefined || current.entries.length > 0) {
        invalidateCurrent(
          lineNumber,
          `${current.section} must contain either API intent entries or exactly one empty sentinel`,
        );
      }
      current.emptyLine = lineNumber;
      continue;
    }

    invalidateCurrent(
      lineNumber,
      `${current.section} accepts only explicit API intent list entries or its empty sentinel`,
    );
  }

  return {
    entries:
      failures.length === 0
        ? sectionRecords.filter((record) => record.valid).flatMap((record) => record.entries)
        : [],
    failures,
  };
};
