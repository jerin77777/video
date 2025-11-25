// server.js - fixed full file
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { getType } = require('mime');
const { v4: uuidv4 } = require('uuid');

// point fluent-ffmpeg to the installed binaries
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;

// enable CORS for all routes
app.use(cors());

// ensure folders exist
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DASH_ROOT = path.join(__dirname, 'public', 'dash');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DASH_ROOT)) fs.mkdirSync(DASH_ROOT, { recursive: true });

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4GB limit; adjust if needed
});

// in-memory progress store (id -> progress). Replace with DB for production.
const progressStore = {};

// serve generated dash files
app.use('/dash', express.static(DASH_ROOT, {
  setHeaders: (res, filePath) => {
    // const type = getType(filePath); // Example of how to use it
    // a DASH manifest MUST be served with the correct content type
    if (path.extname(filePath) === '.mpd') {
      res.setHeader('Content-Type', 'application/dash+xml');
    }
  }
}));

// upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded (field name: file)' });

    const inputPath = req.file.path;
    const id = uuidv4();
    const outDir = path.join(DASH_ROOT, id);
    fs.mkdirSync(outDir, { recursive: true });

    // initialize progress entry
    progressStore[id] = { status: 'queued', percent: 0, createdAt: new Date().toISOString() };

    // read metadata to decide streams and duration
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('ffprobe error:', err);
        progressStore[id] = { status: 'error', error: 'Could not read video metadata.' };
        // respond already returned; client polls status endpoint to see this error
        return;
      }

      const duration = (metadata && metadata.format && metadata.format.duration) ? metadata.format.duration : null;
      const hasVideo = metadata.streams.some(s => s.codec_type === 'video');
      const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');

      if (!hasVideo && !hasAudio) {
        progressStore[id] = { status: 'error', error: 'Input has no audio or video streams.' };
        try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
        return;
      }

      progressStore[id] = { status: 'processing', percent: 0, startedAt: new Date().toISOString() };

      const segDuration = 4; // seconds for segments
      const manifestPath = path.join(outDir, 'manifest.mpd');

      // adaptation sets must be space-separated, not comma-separated
      const adaptationSetParts = [];
      if (hasVideo) adaptationSetParts.push('id=0,streams=v');
      if (hasAudio) adaptationSetParts.push('id=1,streams=a');
      const adaptationSetsArg = adaptationSetParts.join(' '); // IMPORTANT: space separated

      let command = ffmpeg(inputPath);

      // base output options for webm_dash_manifest
      const baseOutputOptions = [
        '-map', '0',
        '-f', 'webm_dash_manifest',
        '-adaptation_sets', adaptationSetsArg,
        '-seg_duration', String(segDuration),
        '-window_size', '5',
        '-extra_window_size', '5',
        '-use_timeline', '1',
        '-use_template', '1',
        '-loglevel', 'info',
        // '-report' // uncomment if you want ffmpeg to write a report file for debugging
      ];

      // add video encoding options if video present
      if (hasVideo) {
        // fluent-ffmpeg will append these output options
        command = command.videoCodec('libvpx-vp9')
                         .videoFilters('scale=-2:720') // keep aspect ratio, height 720
                         .outputOptions([
                           '-crf', '30',
                           '-b:v', '0',     // constant quality for VP9
                           '-g', '240',
                           '-tile-columns', '4',
                           '-threads', '8'
                         ]);
      } else {
        command = command.noVideo();
      }

      // add audio encoding options if audio present (force Opus-compatible params)
      if (hasAudio) {
        command = command.audioCodec('libopus')
                         .audioBitrate('96k')
                         .outputOptions([
                           '-ar', '48000',  // Opus native sample rate
                           '-ac', '2'       // stereo
                         ]);
      } else {
        command = command.noAudio();
      }

      // Final output options and run
      command = command.outputOptions(baseOutputOptions)
                       .output(manifestPath)
                       .on('start', cmd => {
                         console.log('ffmpeg started with:', cmd);
                       })
                       .on('stderr', line => {
                         // verbose ffmpeg output for debugging
                         console.error('[ffmpeg stderr]', line);
                       })
                       .on('progress', progress => {
                         // progress.timemark might be undefined for some inputs; guard
                         if (duration && progress && progress.timemark) {
                           const parts = progress.timemark.split(':');
                           if (parts.length === 3) {
                             const secs = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
                             const percent = Math.min(100, Math.floor((secs / duration) * 100));
                             progressStore[id].percent = percent;
                           }
                         } else if (progress && typeof progress.percent === 'number') {
                           // sometimes fluent-ffmpeg gives percent directly
                           progressStore[id].percent = Math.min(100, Math.floor(progress.percent));
                         }
                         progressStore[id].raw = progress;
                       })
                       .on('error', (err, stdout, stderr) => {
                         console.error('ffmpeg error:', err && err.message);
                         if (stderr) console.error('ffmpeg stderr tail:', stderr.slice ? stderr.slice(-1000) : stderr);
                         progressStore[id] = { status: 'error', error: err && err.message };
                         // try to cleanup uploaded file
                         try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
                       })
                       .on('end', () => {
                         console.log('transcoding finished for', id);
                         progressStore[id] = { status: 'ready', percent: 100, finishedAt: new Date().toISOString() };
                         try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
                       })
                       .run();
    });

    const manifestUrl = `${req.protocol}://${req.get('host')}/dash/${id}/manifest.mpd`;
    return res.json({ id, manifestUrl, statusUrl: `${req.protocol}://${req.get('host')}/status/${id}` });
  } catch (err) {
    console.error('upload handler error:', err);
    return res.status(500).json({ error: 'internal server error', details: err.message });
  }
});

// status endpoint
app.get('/status/:id', (req, res) => {
  const id = req.params.id;
  const status = progressStore[id];
  if (!status) return res.status(404).json({ error: 'id not found' });
  return res.json(status);
});

// tiny player page for testing (dash.js)
app.get('/player/:id', (req, res) => {
  const id = req.params.id;
  const manifestUrl = `${req.protocol}://${req.get('host')}/dash/${id}/manifest.mpd`;
  res.send(`<!doctype html>
    <html>
    <head><meta charset="utf-8"/><title>DASH Player - ${id}</title>
      <script src="https://cdn.dashjs.org/latest/dash.all.min.js"></script>
    </head>
    <body>
      <h3>DASH Player for id: ${id}</h3>
      <video id="video" width="800" controls></video>
      <script>
        const url = "${manifestUrl}";
        const player = dashjs.MediaPlayer().create();
        player.initialize(document.querySelector("#video"), url, true);
      </script>
      <p>Manifest: <a href="${manifestUrl}" target="_blank">${manifestUrl}</a></p>
    </body>
    </html>`);
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Upload endpoint: POST /upload (field name "file")');
});
