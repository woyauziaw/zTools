import express from "express";
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
    limits: {
        fileSize: 15 * 1024 * 1024,
    },
});
const viewsDir = path.join(__dirname, "views");
app.set("views", viewsDir);
app.set("view engine", "pug");
app.use(express.static(path.join(__dirname, "..", "public")));
/**
 * Extracts YouTube Video ID from various URL formats.
 * @param url - YouTube video URL string.
 * @returns Video ID string if valid, otherwise null.
 */
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    return match ? match[1] : null;
}
/**
 * Fetches a direct audio stream URL from cobalt.tools for a given YouTube URL.
 * @param youtubeUrl - Full YouTube video URL.
 * @returns Promise resolving to the audio stream URL and video title.
 */
async function getCobaltAudioUrl(youtubeUrl) {
    const response = await axios.post("https://api.cobalt.tools/", {
        url: youtubeUrl,
        downloadMode: "audio",
        audioFormat: "mp3",
        filenameStyle: "classic",
    }, {
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        timeout: 30000,
    });
    const data = response.data;
    /** cobalt returns status "stream" or "redirect" with a direct url */
    if ((data.status === "stream" || data.status === "redirect" || data.status === "tunnel") &&
        data.url) {
        const title = data.filename
            ?.replace(/\.[^/.]+$/, "")
            .replace(/_/g, " ") ?? "audio";
        return { streamUrl: data.url, title };
    }
    if (data.status === "error") {
        throw new Error(data.error?.code ?? "Cobalt API returned an error.");
    }
    throw new Error("Unexpected response from Cobalt API.");
}
/**
 * Downloads audio bytes from a given direct URL into a Buffer.
 * @param url - Direct audio stream URL.
 * @returns Promise resolving to a Buffer containing the audio data.
 */
async function downloadToBuffer(url) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 120000,
        maxContentLength: Infinity,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
    });
    return Buffer.from(response.data);
}
/**
 * Uploads a file buffer to Top4Top file hosting service.
 * @param buffer - File content stored in a Buffer.
 * @param filename - Name of the file including extension.
 * @returns Promise resolving to the direct download URL.
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
/**
 * Fetches audio via Cobalt API, downloads it, then re-uploads to Top4Top.
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
        const { streamUrl, title } = await getCobaltAudioUrl(youtubeUrl);
        const buffer = await downloadToBuffer(streamUrl);
        const filename = title.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
        const urlResult = await uploadTop4Top(buffer, filename);
        return res.status(200).json({ title, url: urlResult });
    }
    catch (error) {
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
