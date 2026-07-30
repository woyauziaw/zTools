import express, { Request, Response } from "express";
import multer from "multer";
import FormData from "form-data";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Piped public API instances.
 * Source: https://github.com/TeamPiped/Piped/wiki/Instances
 * Endpoint: GET /streams/:videoId
 */
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi-libre.kavin.rocks",
  "https://piped-api.privacy.com.de",
  "https://pipedapi.adminforge.de",
  "https://api.piped.yt",
  "https://pipedapi.drgns.space",
  "https://pipedapi.darkness.services",
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Extracts YouTube Video ID from various URL formats.
 * @param url - YouTube video URL string.
 * @returns Video ID string if valid, otherwise null.
 */
function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
}

interface PipedAudioStream {
  url: string;
  bitrate: number;
  codec: string;
  format: string;
  mimeType: string;
  quality: string;
  videoOnly: boolean;
}

interface PipedStreamsResponse {
  title: string;
  audioStreams: PipedAudioStream[];
}

/**
 * Validates that a response is a proper Piped streams response.
 * @param data - Parsed response body.
 */
function isValidPipedResponse(data: any): data is PipedStreamsResponse {
  return (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof data.title === "string" &&
    Array.isArray(data.audioStreams)
  );
}

/**
 * Fetches stream info from Piped API, trying each instance in sequence.
 * @param videoId - YouTube video ID.
 */
async function fetchPipedStreams(
  videoId: string
): Promise<PipedStreamsResponse> {
  const errors: string[] = [];

  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await axios.get(
        `${instance}/streams/${videoId}`,
        {
          timeout: 20000,
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "application/json",
          },
        }
      );

      const data = response.data;

      if (!isValidPipedResponse(data)) {
        errors.push(`${instance} (invalid response)`);
        continue;
      }

      return data;
    } catch (err: any) {
      const status = err?.response?.status ?? "network error";
      errors.push(`${instance} (${status})`);
    }
  }

  throw new Error(`All Piped instances failed: ${errors.join(", ")}`);
}

/**
 * Picks the best audio stream from Piped audioStreams array.
 * Sorts by bitrate descending and picks the highest quality.
 * @param data - Piped streams API response.
 */
function pickBestAudio(data: PipedStreamsResponse): {
  url: string;
  ext: string;
  mimeType: string;
} {
  const streams = data.audioStreams.filter((s) => s.url && !s.videoOnly);

  if (streams.length === 0) {
    throw new Error("No audio streams available for this video.");
  }

  streams.sort((a, b) => b.bitrate - a.bitrate);
  const best = streams[0];

  const ext =
    best.mimeType?.includes("webm") ? "webm" :
    best.mimeType?.includes("mp4")  ? "m4a"  :
    best.format?.toLowerCase()      ?? "webm";

  return { url: best.url, ext, mimeType: best.mimeType ?? "audio/webm" };
}

/**
 * Downloads content from a direct URL into a Buffer.
 * @param url - Direct stream URL.
 */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: Infinity,
    headers: { "User-Agent": BROWSER_UA },
  });
  return Buffer.from(response.data);
}

/**
 * Uploads a file buffer to Top4Top file hosting service.
 * @param buffer - File content.
 * @param filename - File name with extension.
 * @param contentType - MIME type.
 * @returns Direct download URL.
 */
async function uploadTop4Top(
  buffer: Buffer,
  filename: string,
  contentType: string = "application/octet-stream"
): Promise<string> {
  const initResponse = await axios.get("https://top4top.io/", {
    headers: { "User-Agent": BROWSER_UA },
    timeout: 30000,
  });

  const initHtml: string = initResponse.data;
  const cookies = initResponse.headers["set-cookie"];
  const cookieHeader = cookies
    ? cookies.map((c: string) => c.split(";")[0]).join("; ")
    : "";

  const sid = initHtml.match(/name="sid"\s+value="([^"]+)"/)?.[1];
  if (!sid) {
    throw new Error("Unable to retrieve session ID from Top4Top.");
  }

  const form = new FormData();
  form.append("sid", sid);
  form.append("submitr", "[ رفع الملفات ]");
  form.append("file_0_", buffer, { filename, contentType });

  const uploadResponse = await axios.post(
    "https://top4top.io/index.php",
    form.getBuffer(),
    {
      headers: {
        ...form.getHeaders(),
        "User-Agent": BROWSER_UA,
        Cookie: cookieHeader,
        Referer: "https://top4top.io/",
        Origin: "https://top4top.io",
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    }
  );

  const html: string = uploadResponse.data;

  const patterns = [
    /value="(https:\/\/[a-z0-9]+\.top4top\.io\/m_[^"]+)"/i,
    /value="(https:\/\/[a-z0-9]+\.top4top\.io\/p_[^"]+)"/i,
    /(https:\/\/[a-z0-9]+\.top4top\.io\/m_[a-zA-Z0-9_\-.]+)/i,
    /(https:\/\/[a-z0-9]+\.top4top\.io\/p_[a-zA-Z0-9_\-.]+)/i,
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    if (match) return match[1] || match[0];
  }

  throw new Error("Top4Top failed to return a valid upload URL.");
}

app.get("/", (_req: Request, res: Response) => {
  res.render("index", { title: "Home", activePath: "/" });
});

app.get("/boombox", (_req: Request, res: Response) => {
  res.render("boombox", { title: "Boombox Converter", activePath: "/boombox" });
});

/** Debug: inspect Piped response for a given video ID */
app.get("/api/debug-piped/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const results: any[] = [];

  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await axios.get(`${instance}/streams/${id}`, {
        timeout: 20000,
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      });
      const data = response.data;
      const valid = isValidPipedResponse(data);
      results.push({
        instance,
        valid,
        title: valid ? data.title : null,
        audioStreamsCount: valid ? data.audioStreams.length : "N/A",
        audioStreamsSample: valid ? data.audioStreams.slice(0, 2) : [],
      });
      if (valid) break;
    } catch (err: any) {
      results.push({
        instance,
        valid: false,
        error: `${err?.response?.status ?? err.message}`,
      });
    }
  }

  return res.json(results);
});

/**
 * Fetches audio via Piped API, downloads it, then re-uploads to Top4Top.
 */
app.post("/api/ytdl", async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL parameter is required." });
    }

    const id = extractVideoId(url);
    if (!id) {
      return res.status(400).json({ error: "Invalid YouTube URL format." });
    }

    const data = await fetchPipedStreams(id);
    const { url: audioUrl, ext, mimeType } = pickBestAudio(data);
    const buffer = await downloadToBuffer(audioUrl);

    const safeTitle = (data.title || "audio").replace(/[^a-zA-Z0-9]/g, "_");
    const filename = `${safeTitle}.${ext}`;

    const uploaded = await uploadTop4Top(buffer, filename, mimeType);

    return res.json({ title: data.title, url: uploaded });
  } catch (err: any) {
    return res.status(500).json({
      error: err?.message || "An unexpected error occurred.",
    });
  }
});

/**
 * Uploads a local audio file directly to Top4Top.
 */
app.post(
  "/api/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided." });
      }

      const url = await uploadTop4Top(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      return res.json({ title: req.file.originalname, url });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Upload failed." });
    }
  }
);

export default app;
