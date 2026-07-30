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
 * List of Invidious public instances to try in order.
 * Source: https://docs.invidious.io/instances/
 */
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://inv.thepixora.com",
  "https://yewtu.be",
];

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

interface InvidiousAdaptiveFormat {
  url: string;
  type: string;
  bitrate: string;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: string;
  container: string;
}

interface InvidiousVideoResponse {
  title: string;
  adaptiveFormats: InvidiousAdaptiveFormat[];
  formatStreams: Array<{ url: string; type: string; container: string }>;
}

/**
 * Fetches video metadata from the first responding Invidious instance.
 * Tries each instance in sequence until one succeeds.
 * @param videoId - YouTube video ID.
 * @returns Invidious video API response.
 */
async function fetchInvidiousVideo(
  videoId: string
): Promise<InvidiousVideoResponse> {
  let lastError: Error = new Error("No Invidious instances available.");

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const response = await axios.get<InvidiousVideoResponse>(
        `${instance}/api/v1/videos/${videoId}`,
        { timeout: 15000 }
      );
      return response.data;
    } catch (err: any) {
      lastError = new Error(
        `${instance} failed: ${err.message}`
      );
    }
  }

  throw lastError;
}

/**
 * Picks the best audio-only URL from Invidious adaptiveFormats.
 * Prefers opus/webm, falls back to any audio format, then formatStreams.
 * @param data - Invidious video API response.
 * @returns Direct audio URL and container extension.
 */
function pickAudioFormat(data: InvidiousVideoResponse): {
  url: string;
  ext: string;
} {
  const audioFormats = data.adaptiveFormats.filter(
    (f) => f.type.startsWith("audio/") && f.url
  );

  if (audioFormats.length > 0) {
    /** Sort by bitrate descending to get best quality */
    audioFormats.sort(
      (a, b) => parseInt(b.bitrate) - parseInt(a.bitrate)
    );

    const best = audioFormats[0];
    const ext = best.container ?? (best.type.includes("webm") ? "webm" : "m4a");
    return { url: best.url, ext };
  }

  /** Fallback to formatStreams (muxed video+audio) */
  if (data.formatStreams.length > 0) {
    const stream = data.formatStreams[0];
    return { url: stream.url, ext: stream.container ?? "mp4" };
  }

  throw new Error(
    "No downloadable audio format found for this video."
  );
}

/**
 * Downloads audio from a direct URL into a Buffer.
 * @param url - Direct audio stream URL.
 * @returns Buffer containing the audio data.
 */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: Infinity,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  return Buffer.from(response.data);
}

/**
 * Uploads a file buffer to Top4Top file hosting service.
 * @param buffer - File content stored in a Buffer.
 * @param filename - Name of the file including extension.
 * @param contentType - MIME type of the file.
 * @returns Direct download URL from Top4Top.
 */
async function uploadTop4Top(
  buffer: Buffer,
  filename: string,
  contentType: string = "application/octet-stream"
): Promise<string> {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const initResponse = await axios.get("https://top4top.io/", {
    headers: { "User-Agent": userAgent },
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
        "User-Agent": userAgent,
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

/** Render Index */
app.get("/", (_req: Request, res: Response) => {
  res.render("index", { title: "Home", activePath: "/" });
});

/** Render Boombox */
app.get("/boombox", (_req: Request, res: Response) => {
  res.render("boombox", { title: "Boombox Converter", activePath: "/boombox" });
});

/**
 * Fetches audio via Invidious API, downloads it, then re-uploads to Top4Top.
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

    const data = await fetchInvidiousVideo(id);
    const { url: audioUrl, ext } = pickAudioFormat(data);

    const buffer = await downloadToBuffer(audioUrl);
    const filename =
      (data.title || "audio").replace(/[^a-zA-Z0-9]/g, "_") + "." + ext;

    const mimeType =
      ext === "webm" ? "audio/webm" :
      ext === "m4a"  ? "audio/mp4"  :
      ext === "mp4"  ? "video/mp4"  : "application/octet-stream";

    const uploaded = await uploadTop4Top(buffer, filename, mimeType);

    return res.json({ title: data.title, url: uploaded });
  } catch (err: any) {
    return res.status(500).json({
      error: err?.message || "An unexpected error occurred.",
    });
  }
});

/**
 * Uploads a local MP3/audio file directly to Top4Top.
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
      return res.status(500).json({
        error: err?.message || "Upload failed.",
      });
    }
  }
);

export default app;
