import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
// TTS helper
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static files
app.use(express.static(path.join(__dirname, "assets")));
app.use(express.static(path.join(__dirname)));

// Serve frontend
app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "speach/amharic.html"));
});
app.get("/english", (req, res) => {
res.sendFile(path.join(__dirname, "speach/english.html"));
});

const CAMB_API_KEY = process.env.CAMB_API_KEY
const GROQ_API_KEY = process.env.GROQ_API_KEY
// Main AI route
app.post("/askEnglish", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    // Send request to Groq
    const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "user", content: question }
        ]
      })
    });

    const data = await aiResponse.json();

    // Extract the actual text answer
    const answer = data?.choices?.[0]?.message?.content || "No response from AI";

    res.json({ answer });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Translate function
async function translate(text, sourceLang, targetLang) {
const createRes = await fetch("https://client.camb.ai/apis/translate", {
method: "POST",
headers: {
"Content-Type": "application/json",
"x-api-key": CAMB_API_KEY,
},
body: JSON.stringify({
source_language: sourceLang,
target_language: targetLang,
texts: [text],
}),
});

const createData = await createRes.json();
const taskId = createData.task_id;

if (!taskId) throw new Error("Translation task not created");

let runId = null;
while (!runId) {
const statusRes = await fetch(`https://client.camb.ai/apis/translate/${taskId}`,
{ headers: { "x-api-key": CAMB_API_KEY } }
);
const status = await statusRes.json();

if (status.status === "SUCCESS") runId = status.run_id;  
else if (status.status === "ERROR") throw new Error("Translation failed");  
else await new Promise((r) => setTimeout(r, 1000));

}

const resultRes = await fetch(`https://client.camb.ai/apis/translation-result/${runId}`,
{ headers: { "x-api-key": CAMB_API_KEY } }
);

const result = await resultRes.json();
return result.texts[0];
}

async function generateTTS(text) {
  console.log("🟡 Starting TTS for:", text);

  // 1️⃣ Start TTS task
  const ttsStart = await fetch("https://client.camb.ai/apis/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CAMB_API_KEY
    },
    body: JSON.stringify({
      voice_id: 147328,
      text,
      format: "flac", // request FLAC directly
      language: 3
    })
  });

  const startData = await ttsStart.json();
  if (!startData.task_id) throw new Error("TTS API did not return a task_id");
  const taskId = startData.task_id;
  let runId = null;

  // 2️⃣ Poll TTS status
  while (!runId) {
    const statusRes = await fetch(`https://client.camb.ai/apis/tts/${taskId}`, {
      headers: { "x-api-key": CAMB_API_KEY }
    });
    const statusData = await statusRes.json();

    if (statusData.status === "SUCCESS") runId = statusData.run_id;
    else if (statusData.status === "ERROR") throw new Error("TTS failed");
    else await new Promise((r) => setTimeout(r, 1000));
  }

  // 3️⃣ Fetch FLAC audio directly (binary)
  const audioRes = await fetch(`https://client.camb.ai/apis/tts-result/${runId}`, {
    headers: { "x-api-key": CAMB_API_KEY }
  });

  // Treat as binary
  const flacArrayBuffer = await audioRes.arrayBuffer();
  const flacBuffer = Buffer.from(flacArrayBuffer);

  // 4️⃣ Convert FLAC to MP3
  const mp3Buffer = await new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(flacBuffer);

    const chunks = [];
    const outputStream = new PassThrough();

    outputStream.on("data", (chunk) => chunks.push(chunk));
    outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    outputStream.on("error", reject);

    ffmpeg(inputStream)
      .inputFormat("flac")
      .audioCodec("libmp3lame")
      .format("mp3")
      .on("error", reject)
      .pipe(outputStream, { end: true });
  });

  console.log("✅ TTS conversion complete, returning MP3 buffer");
  return mp3Buffer;
}
app.post("/askAmharic", async (req, res) => {
try {
const { text } = req.body;
if (!text) return res.status(400).json({ error: "No text provided" });

const english = await translate(text, 3, 1);  

const aiRes = await fetch(  
  "https://api.groq.com/openai/v1/chat/completions",  
  {  
    method: "POST",  
    headers: {  
      "Content-Type": "application/json",  
      Authorization: `Bearer ${GROQ_API_KEY}`,  
    },  
    body: JSON.stringify({  
      model: "llama-3.1-8b-instant",  
      messages: [{ role: "user", content: english }],  
    }),  
  }  
).then((r) => r.json());  

const englishAnswer = aiRes.choices[0].message.content;  
const amharic = await translate(englishAnswer, 1, 3);  

const audioBuffer = await generateTTS(amharic);  

res.set("Content-Type", "audio/mpeg");  
return res.send(audioBuffer);

} catch (err) {
console.error("ERROR:", err);
return res.status(500).json({ error: err.message });
}
});

// Simple TTS route
app.post("/generateAudio", async (req, res) => {
try {
const { text } = req.body;
if (!text) return res.status(400).json({ error: "No text provided" });

const audioBuffer = await generateTTS(text);  

res.set("Content-Type", "audio/mpeg");  
return res.send(audioBuffer);

} catch (err) {
console.error("TTS ERROR:", err);
return res.status(500).json({ error: err.message });
}
});


// Render uses PORT env variable
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
