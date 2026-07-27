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
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.use(express.static(path.join(__dirname, "..", "public")));
function getYtDlpPath() {
    const binary = path.join(__dirname, "..", "bin", "yt-dlp");
    if (!fs.existsSync(binary)) {
        throw new Error("yt-dlp binary not found: " + binary);
    }
    try {
        fs.chmodSync(binary, 0o755);
    }
    catch { }
    return binary;
}
function getCookiesPath() {
    const cookie = path.join(__dirname, "..", "bin", "cookies.txt");
    if (!fs.existsSync(cookie)) {
        return null;
    }
    return cookie;
}
function runYtDlp(args) {
    const cookies = getCookiesPath();
    const finalArgs = [
        "--no-check-certificate",
        "--no-playlist",
        "--no-warnings",
    ];
    if (cookies) {
        finalArgs.push("--cookies", cookies);
    }
    return spawn(getYtDlpPath(), [
        ...finalArgs,
        ...args
    ]);
}
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
    return match ? match[1] : null;
}
function getYoutubeInfo(url) {
    return new Promise((resolve, reject) => {
        const child = runYtDlp([
            "-j",
            url
        ]);
        let output = "";
        let error = "";
        child.stdout.on("data", (data) => {
            output += data.toString();
        });
        child.stderr.on("data", (data) => {
            error += data.toString();
        });
        child.on("error", (err) => {
            reject(new Error("yt-dlp execution failed: " + err.message));
        });
        child.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(error.trim() ||
                    "Failed getting YouTube information"));
            }
            try {
                const json = JSON.parse(output);
                resolve(json);
            }
            catch {
                reject(new Error("Invalid yt-dlp JSON response"));
            }
        });
    });
}
function downloadAudio(url, format) {
    return new Promise((resolve, reject) => {
        const child = runYtDlp([
            "-f",
            format,
            "-o",
            "-",
            url
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
            reject(new Error(err.message));
        });
        child.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(error.trim()));
            }
            resolve(Buffer.concat(chunks));
        });
    });
}
async function getAudioBuffer(url) {
    const formats = [
        {
            format: "bestaudio/best",
            ext: "webm"
        },
        {
            format: "bestaudio*",
            ext: "webm"
        },
        {
            format: "best",
            ext: "mp4"
        }
    ];
    let lastError = "";
    for (const item of formats) {
        try {
            console.log("Trying format:", item.format);
            const buffer = await downloadAudio(url, item.format);
            if (buffer.length > 0) {
                return {
                    buffer,
                    ext: item.ext
                };
            }
        }
        catch (err) {
            console.log("Format failed:", item.format, err.message);
            lastError = err.message;
        }
    }
    throw new Error(lastError ||
        "All audio formats failed");
}
async function uploadTop4Top(buffer, filename, contentType = "application/octet-stream") {
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 Chrome/124 Safari/537.36";
    const initResponse = await axios.get("https://top4top.io/", {
        headers: {
            "User-Agent": userAgent,
        },
        timeout: 30000,
    });
    const html = initResponse.data;
    const cookies = initResponse.headers["set-cookie"];
    const cookieHeader = cookies
        ? cookies
            .map((c) => c.split(";")[0])
            .join("; ")
        : "";
    const sid = html.match(/name="sid"\s+value="([^"]+)"/)?.[1];
    if (!sid) {
        throw new Error("Top4Top session ID not found");
    }
    const form = new FormData();
    form.append("sid", sid);
    form.append("submitr", "[ رفع الملفات ]");
    form.append("file_0_", buffer, {
        filename,
        contentType,
    });
    const response = await axios.post("https://top4top.io/index.php", form.getBuffer(), {
        headers: {
            ...form.getHeaders(),
            "User-Agent": userAgent,
            "Cookie": cookieHeader,
            "Referer": "https://top4top.io/",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000,
    });
    const result = response.data;
    const patterns = [
        /value="(https:\/\/[a-z0-9]+\.top4top\.io\/m_[^"]+)"/i,
        /value="(https:\/\/[a-z0-9]+\.top4top\.io\/p_[^"]+)"/i,
        /(https:\/\/[a-z0-9]+\.top4top\.io\/m_[a-zA-Z0-9_\-.]+)/i,
        /(https:\/\/[a-z0-9]+\.top4top\.io\/p_[a-zA-Z0-9_\-.]+)/i,
    ];
    for (const regex of patterns) {
        const match = result.match(regex);
        if (match) {
            return (match[1] ||
                match[0]);
        }
    }
    throw new Error("Top4Top upload URL not found");
}
app.get("/", (_req, res) => {
    res.render("index", {
        title: "Home",
        activePath: "/"
    });
});
function debugFormats(url) {
    return new Promise((resolve, reject) => {
        const child = runYtDlp([
            "-F",
            url
        ]);
        let output = "";
        let error = "";
        child.stdout.on("data", (d) => {
            output += d.toString();
        });
        child.stderr.on("data", (d) => {
            error += d.toString();
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(error));
                return;
            }
            resolve(output);
        });
    });
}
app.get("/boombox", (_req, res) => {
    res.render("boombox", {
        title: "Boombox Converter",
        activePath: "/boombox"
    });
});
app.get("/api/debug-cookies", (_req, res) => {
    const cookie = getCookiesPath();
    if (!cookie) {
        return res.json({
            status: "COOKIE_NOT_FOUND"
        });
    }
    return res.json({
        status: "OK",
        path: cookie,
        size: fs.statSync(cookie).size
    });
});
app.post("/api/ytdl", async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400)
                .json({
                error: "URL required"
            });
        }
        const id = extractVideoId(url);
        if (!id) {
            return res.status(400)
                .json({
                error: "Invalid YouTube URL"
            });
        }
        const youtubeUrl = `https://youtube.com/watch?v=${id}`;
        const info = await getYoutubeInfo(youtubeUrl);
        const formats = await debugFormats(youtubeUrl);
        console.log(formats);
        return res.json({
            formats
        });
        const audio = await getAudioBuffer(youtubeUrl);
        const safeTitle = (info.title ||
            "audio")
            .replace(/[^a-zA-Z0-9]/g, "_");
        const filename = `${safeTitle}.${audio.ext}`;
        const uploaded = await uploadTop4Top(audio.buffer, filename);
        return res.json({
            title: info.title,
            url: uploaded
        });
    }
    catch (err) {
        console.error("YTDL ERROR:", err);
        return res.status(500)
            .json({
            error: err.message ||
                "Processing failed"
        });
    }
});
app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400)
                .json({
                error: "No file"
            });
        }
        const url = await uploadTop4Top(req.file.buffer, req.file.originalname, req.file.mimetype);
        return res.json({
            title: req.file.originalname,
            url
        });
    }
    catch (err) {
        return res.status(500)
            .json({
            error: err.message
        });
    }
});
app.get("/api/version", async (_req, res) => {
    const child = runYtDlp([
        "--version"
    ]);
    let out = "";
    child.stdout.on("data", d => {
        out += d.toString();
    });
    child.on("close", () => {
        res.json({
            version: out
        });
    });
});
export default app;
