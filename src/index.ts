import express, { Request, Response } from "express";
import multer from "multer";
import FormData from "form-data";
import axios from "axios";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
});

const viewsDir = path.join(__dirname, "views");
app.set("views", viewsDir);
app.set("view engine", "pug");

app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Resolves the yt-dlp binary path.
 * Uses bundled binary in production (Vercel), falls back to system binary locally.
 */
function getYtDlpPath(): string {
  if (process.env.NODE_ENV === "production") {
    return path.join(__dirname, "..", "bin", "yt-dlp");
  }
  return "yt-dlp";
}

/**
 * Writes cookies from YTDLP_COOKIES_B64 env var to a temp file and returns its path.
 * Falls back to bundled bin/cookies.txt if env var is not set.
 * @returns Absolute path to cookies file, or null if unavailable.
 */
function getCookiesPath(): string | null {
  const b64 = process.env.YTDLP_COOKIES_B64;
  if (b64) {
    const tmpPath = "/tmp/yt_cookies.txt";
    try {
      fs.writeFileSync(tmpPath, Buffer.from(b64, "base64").toString("utf-8"));
      return tmpPath;
    } catch {
      return null;
    }
  }

  const bundled = path.join(__dirname, "..", "bin", "cookies.txt");
  try {
    fs.accessSync(bundled);
    return bundled;
  } catch {
    return null;
  }
}

/**
 * Spawns the yt-dlp binary with the given arguments, injecting cookies if available.
 * @param args - Command line arguments for yt-dlp.
 */
function runYtDlp(args: string[]) {
  const cookies = getCookiesPath();
  const cookieArgs = cookies ? ["--cookies", cookies] : [];
  return spawn(getYtDlpPath(), [...cookieArgs, ...args]);
}

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

/**
 * Retrieves metadata for a given YouTube URL using yt-dlp.
 * @param url - Full YouTube video URL.
 * @returns Promise resolving to the parsed metadata object.
 */
function getYoutubeInfo(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = runYtDlp(["-j", "--no-playlist", "--no-warnings", url]);

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { error += data.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(error.trim() || "Failed to retrieve YouTube metadata."));
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Invalid JSON output received from yt-dlp."));
      }
    });
  });
}

/**
 * Downloads the best audio stream for a given YouTube URL as a Buffer.
 * @param url - Full YouTube video URL.
 * @returns Promise resolving to the audio Buffer.
 */
function getAudioBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = runYtDlp([
      "-f", "bestaudio",
      "-o", "-",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);

    const chunks: Buffer[] = [];
    let error = "";

    child.stdout.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
    child.stderr.on("data", (data) => { error += data.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(error.trim() || "Failed to download audio stream."));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Uploads a file buffer to Top4Top file hosting service.
 * @param buffer - File content stored in a Buffer.
 * @param filename - Name of the file including extension.
 * @returns Promise resolving to the direct download URL.
 */
async function uploadTop4Top(buffer: Buffer, filename: string): Promise<string> {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const initResponse = await axios.get("https://top4top.io/", {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
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
  form.append("file_0_", buffer, {
    filename,
    contentType: "audio/mpeg",
  });

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
    /https:\/\/[a-z0-9]+\.top4top\.io\/m_[a-zA-Z0-9_\-.]+/i,
    /https:\/\/[a-z0-9]+\.top4top\.io\/p_[a-zA-Z0-9_\-.]+/i,
  ];

  for (const regex of patterns) {
    const found = html.match(regex);
    if (found) {
      return found[1] || found[0];
    }
  }

  const errMatch = html.match(/<div class="error">([^<]+)<\/div>/i);
  if (errMatch) {
    throw new Error(`Top4Top Error: ${errMatch[1]}`);
  }

  throw new Error("Top4Top failed to return a valid upload URL.");
}

// Render Index (Dashboard)
app.get("/", (_req: Request, res: Response) => {
  res.render("index", { title: "Home", activePath: "/" });
});

// Render Boombox
app.get("/boombox", (_req: Request, res: Response) => {
  res.render("boombox", { title: "Boombox Converter", activePath: "/boombox" });
});

/** Temporary debug endpoint — remove after confirming cookies work */
app.get("/api/debug-cookies", (_req: Request, res: Response) => {
  const b64 = process.env.YTDLP_COOKIES_B64;

  if (!b64) {
    return res.json({ status: "NO_ENV_VAR" });
  }

  try {
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    const tmpPath = "/tmp/yt_cookies.txt";
    fs.writeFileSync(tmpPath, decoded);
    const written = fs.readFileSync(tmpPath, "utf-8");
    return res.json({
      status: "OK",
      env_length: b64.length,
      decoded_lines: decoded.split("\n").length,
      first_line: decoded.split("\n")[0],
      file_written: written.length > 0,
    });
  } catch (e: any) {
    return res.json({ status: "ERROR", message: e.message });
  }
});

/**
 * Downloads audio from YouTube and re-uploads it to Top4Top.
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

    const youtubeUrl = `https://youtube.com/watch?v=${id}`;
    const info = await getYoutubeInfo(youtubeUrl);
    const audio = await getAudioBuffer(youtubeUrl);

    const filename = info.title.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
    const urlResult = await uploadTop4Top(audio, filename);

    return res.status(200).json({ title: info.title, url: urlResult });
  } catch (error: any) {
    return res.status(500).json({
      error:
        error?.message ||
        "An unexpected error occurred while processing the video.",
    });
  }
});

/**
 * Uploads a local file directly to Top4Top.
 */
app.post(
  "/api/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided in the request." });
      }

      const url = await uploadTop4Top(req.file.buffer, req.file.originalname);

      return res.status(200).json({ title: req.file.originalname, url });
    } catch (error: any) {
      return res.status(500).json({
        error:
          error?.message || "An error occurred while uploading the file.",
      });
    }
  }
);

export default app;
