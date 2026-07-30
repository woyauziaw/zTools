import express from "express";
import multer from "multer";
import FormData from "form-data";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { createDecipheriv } from "crypto";
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
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36";
const audioQualities = [92, 128, 256, 320];
/**
 * Extracts YouTube Video ID from various URL formats.
 * @param {string} url - YouTube video URL string.
 * @returns {string | null} Video ID string if valid, otherwise null.
 */
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    return match ? match[1] : null;
}
/**
 * Decrypts backend payload data using AES-128-CBC.
 * @param {string} enc - Base64 encoded encrypted string.
 * @returns {any} Parsed JSON metadata object.
 */
function decodePayload(enc) {
    const secretKey = "C5D58EF67A7584E4A29F6C35BBC4EB12";
    const data = Buffer.from(enc, "base64");
    const iv = data.slice(0, 16);
    const content = data.slice(16);
    const key = Buffer.from(secretKey, "hex");
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const decrypted = Buffer.concat([
        decipher.update(content),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString());
}
/**
 * Fetches direct audio stream URL internally without exposing third-party services.
 * @param {string} videoUrl - Full YouTube video URL.
 * @param {number} quality - Audio bitrate.
 * @returns {Promise<{ title: string; url: string }>} Audio title and direct stream URL.
 */
async function fetchInternalAudioStream(videoUrl, quality) {
    const cdnRes = await axios.get("https://media.savetube.vip/api/random-cdn", {
        headers: { "User-Agent": BROWSER_UA },
        timeout: 10000,
    });
    const cdn = cdnRes.data.cdn;
    const infoRes = await axios.post(`https://${cdn}/v2/info`, { url: videoUrl }, {
        headers: {
            "User-Agent": BROWSER_UA,
            Referer: "https://save-tube.com/",
            "Content-Type": "application/json",
        },
        timeout: 15000,
    });
    const info = decodePayload(infoRes.data.data);
    const downloadRes = await axios.post(`https://${cdn}/download`, {
        downloadType: "audio",
        quality: `${quality}`,
        key: info.key,
    }, {
        headers: {
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
            Referer: "https://save-tube.com/",
        },
        timeout: 15000,
    });
    const downloadUrl = downloadRes.data?.data?.downloadUrl;
    if (!downloadUrl) {
        throw new Error("Failed to resolve audio stream URL.");
    }
    return {
        title: info.title || "audio",
        url: downloadUrl,
    };
}
/**
 * Downloads content from a direct URL into a Buffer.
 * @param {string} url - Direct stream URL.
 * @returns {Promise<Buffer>} Downloaded file buffer.
 */
async function downloadToBuffer(url) {
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
 * @param {Buffer} buffer - File content.
 * @param {string} filename - File name with extension.
 * @param {string} contentType - MIME type.
 * @returns {Promise<string>} Direct download URL.
 */
async function uploadTop4Top(buffer, filename, contentType = "application/octet-stream") {
    const initResponse = await axios.get("https://top4top.io/", {
        headers: { "User-Agent": BROWSER_UA },
        timeout: 30000,
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
    form.append("file_0_", buffer, { filename, contentType });
    const uploadResponse = await axios.post("https://top4top.io/index.php", form.getBuffer(), {
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
    });
    const html = uploadResponse.data;
    const patterns = [
        /value="(https:\/\/[a-z0-9]+\.top4top\.io\/m_[^"]+)"/i,
        /value="(https:\/\/[a-z0-9]+\.top4top\.io\/p_[^"]+)"/i,
        /(https:\/\/[a-z0-9]+\.top4top\.io\/m_[a-zA-Z0-9_\-.]+)/i,
        /(https:\/\/[a-z0-9]+\.top4top\.io\/p_[a-zA-Z0-9_\-.]+)/i,
    ];
    for (const regex of patterns) {
        const match = html.match(regex);
        if (match) {
            return match[1] || match[0];
        }
    }
    throw new Error("Top4Top failed to return a valid upload URL.");
}
app.get("/", (_req, res) => {
    res.render("index", { title: "Home", activePath: "/" });
});
app.get("/boombox", (_req, res) => {
    res.render("boombox", { title: "Boombox Converter", activePath: "/boombox" });
});
/**
 * Renders the API documentation view page.
 */
app.get("/api", (_req, res) => {
    res.render("api", { title: "API Documentation", activePath: "/api" });
});
/**
 * Fetches audio internally, downloads it, then re-uploads to Top4Top.
 */
app.post("/api/ytdl", async (req, res) => {
    try {
        const { url, quality } = req.body;
        if (!url) {
            res.status(400).json({ error: "URL parameter is required." });
            return;
        }
        const id = extractVideoId(url);
        if (!id) {
            res.status(400).json({ error: "Invalid YouTube URL format." });
            return;
        }
        const requestedQuality = Number(quality) || 128;
        const format = audioQualities.includes(requestedQuality)
            ? requestedQuality
            : 128;
        const cleanUrl = `https://www.youtube.com/watch?v=${id}`;
        const audioData = await fetchInternalAudioStream(cleanUrl, format);
        const buffer = await downloadToBuffer(audioData.url);
        const safeTitle = (audioData.title || "audio").replace(/[^a-zA-Z0-9]/g, "_");
        const filename = `${safeTitle}.${format}kbps.mp3`;
        const uploaded = await uploadTop4Top(buffer, filename, "audio/mpeg");
        res.json({ title: audioData.title, url: uploaded });
    }
    catch (err) {
        res.status(500).json({
            error: err?.message || "An unexpected error occurred.",
        });
    }
});
/**
 * Uploads a local audio file directly to Top4Top.
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: "No file provided." });
            return;
        }
        const url = await uploadTop4Top(req.file.buffer, req.file.originalname, req.file.mimetype);
        res.json({ title: req.file.originalname, url });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Upload failed." });
    }
});
export default app;
