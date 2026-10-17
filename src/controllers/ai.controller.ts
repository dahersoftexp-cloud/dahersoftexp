import { Response, Request } from "express";
import { get, push, ref, set, update } from "../utils/tenantFirebase";
import { database } from "../firebaseConfig";
import { v4 as uuid } from "uuid";
import {
  AIDataSnapshot,
  AIJsonValue,
  AISection,
  AIStoredEntry,
} from "../types/ai";

const NUMBERED_SECTION_REGEX = /(?:^|\s)(\d+)\)\s*([\s\S]*?)(?=(?:\s\d+\)\s)|$)/g;
const BULLET_SPLIT_REGEX = /\s+-\s+/;
const JSON_WRAPPER_KEYS = new Set([
  "title",
  "prompt",
  "content",
  "text",
  "payload",
  "data",
  "result",
]);
const APP_TIME_ZONE = "Asia/Damascus";
const ISO_DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}/;

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/\u200f/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (value: unknown): value is AIJsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
};

const extractItems = (content: string): string[] =>
  content
    .split(BULLET_SPLIT_REGEX)
    .map((item) => item.trim())
    .filter(Boolean);

const createSection = (order: number, sectionText: string): AISection => {
  const cleanedText = normalizeWhitespace(sectionText);
  const dividerIndex = cleanedText.indexOf(" - ");

  if (dividerIndex === -1) {
    return {
      order,
      title: `Section ${order}`,
      content: cleanedText,
      items: extractItems(cleanedText),
    };
  }

  const title = cleanedText.slice(0, dividerIndex).trim();
  const content = cleanedText.slice(dividerIndex + 3).trim();

  return {
    order,
    title: title || `Section ${order}`,
    content,
    items: extractItems(content),
  };
};

const parseSections = (rawText: string, fallbackTitle?: string): AISection[] => {
  const normalizedText = normalizeWhitespace(rawText);
  const sections: AISection[] = [];
  let match: RegExpExecArray | null;

  NUMBERED_SECTION_REGEX.lastIndex = 0;

  while ((match = NUMBERED_SECTION_REGEX.exec(normalizedText)) !== null) {
    const order = Number(match[1]);
    const sectionText = match[2]?.trim();

    if (!sectionText) {
      continue;
    }

    sections.push(createSection(order, sectionText));
  }

  if (sections.length > 0) {
    return sections;
  }

  return [
    {
      order: 1,
      title: fallbackTitle?.trim() || "AI Response",
      content: normalizedText,
      items: extractItems(normalizedText),
    },
  ];
};

const buildPayloadSummary = (payload: AIJsonValue): string => {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return "JSON array (0 items)";
    }

    const firstItem = payload[0];

    if (isPlainObject(firstItem)) {
      const type = typeof firstItem.type === "string" ? firstItem.type : "JSON array";
      const date =
        typeof firstItem.date === "string" ? ` - ${firstItem.date}` : "";

      return `${type}${date} (${payload.length} item${payload.length === 1 ? "" : "s"})`;
    }

    return `JSON array (${payload.length} items)`;
  }

  if (isPlainObject(payload)) {
    const type = typeof payload.type === "string" ? payload.type : "JSON object";
    const date = typeof payload.date === "string" ? ` - ${payload.date}` : "";

    return `${type}${date}`;
  }

  return String(payload);
};

const buildStoredEntry = (
  input: string | AIJsonValue,
  title?: string
): AIStoredEntry => {
  const payload = typeof input === "string" ? undefined : input;
  const rawText =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const normalizedText = normalizeWhitespace(rawText);
  const sections = parseSections(normalizedText, title);
  const summary =
    payload !== undefined
      ? buildPayloadSummary(payload)
      : sections[0]?.items[0] ||
        sections[0]?.content ||
        normalizedText.slice(0, 200);

  return {
    title: title?.trim() || "AI Response",
    rawText: normalizedText,
    summary,
    sections,
    createdAt: new Date().toISOString(),
    ...(payload !== undefined ? { payload } : {}),
  };
};

const readStringField = (
  record: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = record[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : undefined;
};

const parseMaybeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseDateValue = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};

const getSnapshotDateKey = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string") {
      const isoDate = value.match(ISO_DATE_PREFIX_REGEX)?.[0];

      if (isoDate) {
        return isoDate;
      }
    }

    const parsedDate = parseDateValue(value);

    if (parsedDate) {
      return parsedDate.toLocaleDateString("en-CA", {
        timeZone: APP_TIME_ZONE,
      });
    }
  }

  return new Date().toLocaleDateString("en-CA", {
    timeZone: APP_TIME_ZONE,
  });
};

const normalizeSection = (value: unknown, index: number): AISection | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const title = readStringField(value, "title") || `Section ${index + 1}`;
  const content = normalizeWhitespace(
    readStringField(value, "content") ||
      readStringField(value, "rawText") ||
      ""
  );
  const order =
    typeof value.order === "number" && Number.isFinite(value.order)
      ? value.order
      : index + 1;
  const items = Array.isArray(value.items)
    ? value.items
        .map((item) => (typeof item === "string" ? normalizeWhitespace(item) : ""))
        .filter(Boolean)
    : extractItems(content);

  return {
    order,
    title,
    content,
    items,
  };
};

const looksLikeStoredEntry = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  (typeof value.title === "string" ||
    typeof value.summary === "string" ||
    typeof value.rawText === "string" ||
    Array.isArray(value.sections));

const buildStoredEntryFromReport = (
  report: Record<string, unknown>,
  createdAtFallback: string
): AIStoredEntry => {
  const title = readStringField(report, "title") || "AI Response";
  const rawText = normalizeWhitespace(
    readStringField(report, "rawText") ||
      readStringField(report, "content") ||
      readStringField(report, "text") ||
      readStringField(report, "summary") ||
      JSON.stringify(report, null, 2)
  );
  const normalizedSections = Array.isArray(report.sections)
    ? report.sections
        .map((section, index) => normalizeSection(section, index))
        .filter((section): section is AISection => section !== null)
    : [];
  const sections =
    normalizedSections.length > 0
      ? normalizedSections
      : parseSections(rawText, title);
  const summary =
    readStringField(report, "summary") ||
    sections[0]?.content ||
    rawText.slice(0, 200);
  const storedEntry: AIStoredEntry = {
    title,
    rawText,
    summary: normalizeWhitespace(summary),
    sections,
    createdAt: readStringField(report, "createdAt") || createdAtFallback,
  };

  if (isJsonValue(report)) {
    storedEntry.payload = report;
  }

  return storedEntry;
};

const buildStoredEntryFromUnknown = (
  value: unknown,
  createdAtFallback: string
): AIStoredEntry | null => {
  if (typeof value === "string") {
    const parsedValue = parseMaybeJson(value);

    if (looksLikeStoredEntry(parsedValue)) {
      return buildStoredEntryFromReport(parsedValue, createdAtFallback);
    }

    if (isJsonValue(parsedValue) && parsedValue !== value) {
      return buildStoredEntry(parsedValue);
    }

    return buildStoredEntry(value);
  }

  if (looksLikeStoredEntry(value)) {
    return buildStoredEntryFromReport(value, createdAtFallback);
  }

  if (isJsonValue(value)) {
    return buildStoredEntry(value);
  }

  return null;
};

const unwrapSnapshotBody = (body: unknown): unknown => {
  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "prompt")) {
    return body.prompt;
  }

  if (isPlainObject(body)) {
    const entries = Object.entries(body);

    if (entries.length === 1 && JSON_WRAPPER_KEYS.has(entries[0][0])) {
      return entries[0][1];
    }
  }

  return body;
};

const readNestedStringField = (value: unknown, key: string): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedValue = readNestedStringField(item, key);

      if (nestedValue) {
        return nestedValue;
      }
    }

    return undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const directValue = readStringField(value, key);

  if (directValue) {
    return directValue;
  }

  for (const nestedKey of ["data", "payload", "result", "response"]) {
    if (Object.prototype.hasOwnProperty.call(value, nestedKey)) {
      const nestedValue = readNestedStringField(value[nestedKey], key);

      if (nestedValue) {
        return nestedValue;
      }
    }
  }

  return undefined;
};

const extractAIOutputText = (value: unknown): string | null => {
  const texts: string[] = [];

  const visit = (currentValue: unknown): void => {
    if (Array.isArray(currentValue)) {
      currentValue.forEach(visit);
      return;
    }

    if (!isPlainObject(currentValue)) {
      return;
    }

    const outputText = readStringField(currentValue, "output_text");
    const text = readStringField(currentValue, "text");

    if (outputText) {
      texts.push(outputText);
    }

    if (text) {
      texts.push(text);
    }

    for (const nestedKey of ["data", "payload", "result", "response"]) {
      if (Object.prototype.hasOwnProperty.call(currentValue, nestedKey)) {
        visit(currentValue[nestedKey]);
      }
    }

    if (Array.isArray(currentValue.output)) {
      currentValue.output.forEach(visit);
    }

    if (Array.isArray(currentValue.content)) {
      currentValue.content.forEach(visit);
    }
  };

  visit(value);

  return texts.length > 0 ? texts.join("\n").trim() : null;
};

interface NormalizedSnapshotPayload {
  date: string;
  snapshot: Record<string, unknown>;
  storedEntry?: AIStoredEntry;
}

interface LatestReportResult {
  entry: AIStoredEntry;
  entryId: string | null;
  updatedAt: string;
}

const normalizeSnapshotPayload = (body: unknown): NormalizedSnapshotPayload | null => {
  const payload = unwrapSnapshotBody(body);
  const now = new Date().toISOString();
  const sourceCreatedAt = readNestedStringField(payload, "createdAt");
  const sourceUpdatedAt = readNestedStringField(payload, "updatedAt");
  const fallbackCreatedAt = sourceCreatedAt || now;
  const aiOutputText = extractAIOutputText(payload);
  const parsedAIOutput = aiOutputText ? parseMaybeJson(aiOutputText) : null;
  const shouldBuildEntryFromPayload =
    parsedAIOutput === null &&
    (looksLikeStoredEntry(payload) || typeof payload === "string");
  const storedEntry =
    parsedAIOutput !== null
      ? buildStoredEntryFromUnknown(parsedAIOutput, fallbackCreatedAt)
      : shouldBuildEntryFromPayload
      ? buildStoredEntryFromUnknown(payload, fallbackCreatedAt)
      : null;

  if (storedEntry) {
    const reportPayload = isPlainObject(parsedAIOutput) ? parsedAIOutput : payload;
    const date = getSnapshotDateKey(
      isPlainObject(reportPayload) ? reportPayload.date : undefined,
      isPlainObject(payload) ? payload.date : undefined,
      sourceCreatedAt,
      storedEntry.createdAt
    );
    const snapshot: Record<string, unknown> = {
      date,
      title: storedEntry.title,
      summary: storedEntry.summary,
      rawText: storedEntry.rawText,
      sections: storedEntry.sections,
      response: storedEntry,
      source: aiOutputText ? "n8n" : "api",
      createdAt: sourceCreatedAt || storedEntry.createdAt,
      savedAt: now,
    };

    if (sourceUpdatedAt) {
      snapshot.sourceUpdatedAt = sourceUpdatedAt;
    }

    return {
      date,
      snapshot,
      storedEntry,
    };
  }

  if (isPlainObject(payload)) {
    const date = getSnapshotDateKey(payload.date, payload.createdAt, sourceCreatedAt);
    const snapshot: Record<string, unknown> = {
      ...payload,
      date,
      createdAt: readStringField(payload, "createdAt") || now,
      savedAt: now,
    };

    return {
      date,
      snapshot,
    };
  }

  return null;
};

const sendLatestReport = (
  res: Response,
  entry: AIStoredEntry,
  entryId: string | null,
  updatedAt?: string
) => {
  const resolvedUpdatedAt = updatedAt || entry.createdAt;

  return res.status(200).json({
    entryId,
    updatedAt: resolvedUpdatedAt,
    data: {
      ...entry,
      entryId,
      updatedAt: resolvedUpdatedAt,
    },
  });
};

const getLatestSnapshotReport = async (): Promise<LatestReportResult | null> => {
  const snapshots = await get(ref(database, "analytics/snapshots"));

  if (!snapshots.exists()) {
    return null;
  }

  const snapshotsValue = snapshots.val();

  if (!isPlainObject(snapshotsValue)) {
    return null;
  }

  const reports: LatestReportResult[] = [];

  Object.entries(snapshotsValue).forEach(([snapshotDate, snapshotValue]) => {
    if (!isPlainObject(snapshotValue)) {
      return;
    }

    const fallbackCreatedAt =
      readStringField(snapshotValue, "createdAt") || snapshotDate;
    const entrySource = isPlainObject(snapshotValue.response)
      ? snapshotValue.response
      : snapshotValue;
    const entry = buildStoredEntryFromUnknown(entrySource, fallbackCreatedAt);

    if (!entry) {
      return;
    }

    reports.push({
      entry,
      entryId: null,
      updatedAt:
        readStringField(snapshotValue, "savedAt") ||
        readStringField(snapshotValue, "updatedAt") ||
        readStringField(snapshotValue, "createdAt") ||
        entry.createdAt,
    });
  });

  if (reports.length === 0) {
    return null;
  }

  return reports.sort((a, b) => {
    const bDate = parseDateValue(b.updatedAt)?.getTime() || 0;
    const aDate = parseDateValue(a.updatedAt)?.getTime() || 0;

    return bDate - aDate;
  })[0];
};

const readNumberField = (
  record: Record<string, unknown>,
  key: string
): number => {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);

    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return 0;
};

const extractSavePayload = (body: unknown): unknown => {
  const bodyPayload =
    isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "item")
      ? body.item
      : body;
  const unwrappedPayload = unwrapSnapshotBody(bodyPayload);
  const aiOutputText = extractAIOutputText(unwrappedPayload);

  return aiOutputText ? parseMaybeJson(aiOutputText) : unwrappedPayload;
};

const getValidationText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (isJsonValue(value)) {
    return JSON.stringify(value);
  }

  return "";
};

const containsAIError = (value: unknown): boolean => {
  const validationText = getValidationText(value).toLowerCase();

  return (
    validationText.includes("error") ||
    validationText.includes("exception")
  );
};

const buildReportSnapshot = (report: Record<string, unknown>) => ({
  totalProducts: readNumberField(report, "totalProducts"),
  totalCustomers: readNumberField(report, "totalCustomers"),
  totalSales: readNumberField(report, "totalSales"),
  totalPayments: readNumberField(report, "totalPayments"),
});





export const saveAiReport = async (req: Request, res: Response) => {
  try {
    const reportPayload = extractSavePayload(req.body);

    if (!reportPayload) {
      return res.status(400).json({
        success: false,
        message: "AI report payload not found",
      });
    }

    if (containsAIError(reportPayload)) {
      return res.status(400).json({
        success: false,
        message:
          "AI response contains error indications. Report not saved.",
      });
    }

    const createdAt = new Date().toISOString();
    const storedEntry = buildStoredEntryFromUnknown(reportPayload, createdAt);

    if (!storedEntry) {
      return res.status(400).json({
        success: false,
        message: "Invalid AI report payload",
      });
    }

    const parsedReport = isPlainObject(reportPayload) ? reportPayload : {};
    const reportId = uuid();
    const reportData = {
      id: reportId,

      type: readStringField(parsedReport, "type") || "financial-analysis",

      title: storedEntry.title,

      summary: storedEntry.summary,

      rawText: storedEntry.rawText,

      sections: storedEntry.sections,

      snapshot: buildReportSnapshot(parsedReport),

      meta: {
        generatedBy:
          readStringField(parsedReport, "generatedBy") || "openai",
        model: readStringField(parsedReport, "model") || "gpt-5.5",
      },

      createdAt: storedEntry.createdAt || createdAt,
    };

    await set(
      ref(database, `aiReports/${reportId}`),
      reportData
    );

    return res.status(200).json({
      success: true,
      report: reportData,
    });

  } catch (error: any) {

    console.error("SAVE AI REPORT ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });

  }
};

export const getSnapshot = async (req: Request, res: Response) => {
  try {


    const snapshotsRef = ref(database, "analytics/snapshots");
    const snapshot = await get(snapshotsRef);


    if (!snapshot.exists()) {
      return res.status(404).json({ error: "No snapshots found" });
    }
    res.status(200).json(snapshot.val());

  } catch (error: any) {
    console.error("Error fetching previous snapshot:", error);
    return res.status(500).json({ error: error.message });
  }
};


export const getLatestResponse = async (req: Request, res: Response) => {
  try {
    const snapshot = await get(ref(database, "ai"));

    if (snapshot.exists()) {
      const aiData = snapshot.val() as AIDataSnapshot;

      if (aiData.lastResponse) {
        return sendLatestReport(
          res,
          aiData.lastResponse,
          aiData.lastResponseId || null,
          aiData.updatedAt || aiData.lastResponse.createdAt
        );
      }

      if (typeof aiData.lastPrompt === "string" && aiData.lastPrompt.trim()) {
        const fallbackEntry = buildStoredEntry(aiData.lastPrompt);

        return sendLatestReport(
          res,
          fallbackEntry,
          aiData.lastResponseId || null,
          aiData.updatedAt || fallbackEntry.createdAt
        );
      }
    }

    const latestSnapshotReport = await getLatestSnapshotReport();

    if (latestSnapshotReport) {
      return sendLatestReport(
        res,
        latestSnapshotReport.entry,
        latestSnapshotReport.entryId,
        latestSnapshotReport.updatedAt
      );
    }

    return res.status(404).json({ error: "No AI response found." });
  } catch (error: any) {
    console.error("Error fetching latest AI response:", error);
    return res.status(500).json({
      error: "An error occurred while fetching the AI response.",
    });
  }
};

export const allData = async (req: Request, res: Response) => {
  return res.status(410).json({ error: "ENDPOINT_RETIRED" });
};
