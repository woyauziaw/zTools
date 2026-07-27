import express from "express";
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
 * Dynamically grants execution permissions (+x) on production (Vercel).
 */
function getYtDlpPath() {
    let binPath = "yt-dlp";
    if (process.env.NODE_ENV === "production") {
        binPath = path.join(__dirname, "..", "bin", "yt-dlp");
        try {
            fs.chmodSync(binPath, "755");
        }
        catch (err) {
            console.warn("Failed to grant execute permission to yt-dlp binary:", err);
        }
    }
    return binPath;
}
/**
 * Copies cookies.txt to /tmp directory so yt-dlp can access it.
 * @returns Path to cookies file in /tmp, or null if missing.
 */
function getCookiesPath() {
    const possiblePaths = [
        path.join(__dirname, "..", "bin", "cookies.txt"),
        path.join(__dirname, "bin", "cookies.txt"),
        path.join(__dirname, "..", "cookies.txt"),
    ];
    let srcPath = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            srcPath = p;
            break;
        }
    }
    if (!srcPath) {
        console.warn("cookies.txt was not found in any expected directory.");
        return null;
    }
    const tmpCookiesPath = path.join("/tmp", "yt_cookies.txt");
    try {
        fs.copyFileSync(srcPath, tmpCookiesPath);
        return tmpCookiesPath;
    }
    catch (err) {
        console.error("Failed to copy cookies to /tmp:", err);
        return srcPath;
    }
}
/**
 * Spawns the yt-dlp binary with player client overrides to bypass YouTube bot blocks.
 */
function runYtDlp(args) {
    const cookies = getCookiesPath();
    const cookieArgs = cookies ? ["--cookies", cookies] : [];
    const bypassArgs = [
        "--extractor-args",
        // Try web, android, and tv clients sequentially
        "youtube:player_client=web,android,tv",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ];
    return spawn(getYtDlpPath(), [...cookieArgs, ...bypassArgs, ...args]);
}
/**
 * Extracts YouTube Video ID from various URL formats.
 */
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    return match ? match[1] : null;
}
/**
 * Retrieves metadata for a given YouTube URL using yt-dlp.
 */
function getYoutubeInfo(url) {
    return new Promise((resolve, reject) => {
        const child = runYtDlp(["-j", "--no-playlist", "--no-warnings", url]);
        let output = "";
        let error = "";
        child.stdout.on("data", (data) => {
            output += data.toString();
        });
        child.stderr.on("data", (data) => {
            error += data.toString();
        });
        child.on("error", (err) => {
            reject(new Error(`Failed to execute yt-dlp binary: ${err.message}`));
        });
        child.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(error.trim() || "Failed to retrieve YouTube metadata."));
            }
            try {
                resolve(JSON.parse(output));
            }
            catch {
                reject(new Error("Invalid JSON output received from yt-dlp."));
            }
        });
    });
}
/**
 * Downloads the best audio stream for a given YouTube URL as a Buffer.
 */
function getAudioBuffer(url) {
    return new Promise((resolve, reject) => {
        const child = runYtDlp([
            "-f",
            "bestaudio/best", // Fallback to any available audio stream
            "-o",
            "-",
            "--no-playlist",
            "--no-warnings",
            url,
        ]);
        const chunks = [];
        let error = "";
        child.stdout.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk));
        });
        child.stderr.on("data", (data) => {
            error += data.toString();
        });
        child.on("error", (err) => {
            reject(new Error(`Failed to execute yt-dlp binary: ${err.message}`));
        });
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
 */
async function uploadTop4Top(buffer, filename) {
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const initResponse = await axios.get("https://top4top.io/", {
        headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    });
    const initHtml = initResponse.data;
    const cookies = initResponse.headers["set-cookie"];
    const cookieHeader = cookies
        ? cookies.map((c) => c.split(";")[0]).join("; ")
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
    const uploadResponse = await axios.post("https://top4top.io/index.php", form.getBuffer(), {
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
    });
    const html = uploadResponse.data;
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
app.get("/", (_req, res) => {
    res.render("index", { title: "Home", activePath: "/" });
});
// Render Boombox
app.get("/boombox", (_req, res) => {
    res.render("boombox", { title: "Boombox Converter", activePath: "/boombox" });
});
/** Debug endpoint to verify repo cookies.txt file access in production */
app.get("/api/debug-cookies", (_req, res) => {
    const cookiePath = getCookiesPath();
    if (!cookiePath) {
        return res.json({ status: "COOKIE_FILE_NOT_FOUND" });
    }
    try {
        const content = fs.readFileSync(cookiePath, "utf-8");
        const lines = content.split("\n");
        return res.json({
            status: "OK",
            file_path: cookiePath,
            total_lines: lines.length,
            first_line: lines[0],
            has_netscape_header: content.startsWith("# Netscape"),
        });
    }
    catch (e) {
        return res.json({ status: "ERROR", message: e.message });
    }
});
/**
 * Downloads audio from YouTube and re-uploads it to Top4Top.
 */
app.post("/api/ytdl", async (req, res) => {
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
        const safeTitle = (info.title || "audio").replace(/[^a-zA-Z0-9]/g, "_");
        const filename = `${safeTitle}.mp3`;
        const urlResult = await uploadTop4Top(audio, filename);
        return res.status(200).json({ title: info.title, url: urlResult });
    }
    catch (error) {
        console.error("YTDL Endpoint Error:", error);
        return res.status(500).json({
            error: error?.message ||
                "An unexpected error occurred while processing the video.",
        });
    }
});
/**
 * Uploads a local file directly to Top4Top.
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res
                .status(400)
                .json({ error: "No file provided in the request." });
        }
        const url = await uploadTop4Top(req.file.buffer, req.file.originalname);
        return res.status(200).json({ title: req.file.originalname, url });
    }
    catch (error) {
        return res.status(500).json({
            error: error?.message || "An error occurred while uploading the file.",
        });
    }
});
export default app;
