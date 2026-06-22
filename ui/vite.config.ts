import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { promises as fs } from "fs";
import { componentTagger } from "lovable-tagger";

/**
 * MicVAD (`@ricky0123/vad-web`) lazy-loads two onnxruntime-web WASM modules
 * (`ort-wasm-simd-threaded.{mjs,wasm}`) and its own VAD worklet + Silero
 * ONNX model at runtime. Vite does not auto-copy those out of node_modules,
 * so without this plugin the browser hits 404 on
 * /assets/ort-wasm-simd-threaded.mjs and voice mode fails with
 * "no available backend found".
 *
 * We copy them into the build output at:
 *   /ort/  ← onnxruntime-web WASM/MJS pair (+ jsep variant as a fallback)
 *   /vad/  ← VAD worklet + Silero ONNX models
 * and set `onnxWASMBasePath` / `baseAssetPath` on `MicVAD.new`
 * in voice-mode-dialog.tsx to point at those folders.
 */
const VOICE_ASSETS: Array<{ src: string; dest: string }> = [
  // onnxruntime-web WASM backend — both regular and JSEP fallback
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",      dest: "ort/ort-wasm-simd-threaded.mjs" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",     dest: "ort/ort-wasm-simd-threaded.wasm" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", dest: "ort/ort-wasm-simd-threaded.jsep.mjs" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",dest: "ort/ort-wasm-simd-threaded.jsep.wasm" },
  // VAD worklet + Silero models
  { src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",    dest: "vad/vad.worklet.bundle.min.js" },
  { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",           dest: "vad/silero_vad_v5.onnx" },
  { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx",       dest: "vad/silero_vad_legacy.onnx" },
];

const EXT_MIME: Record<string, string> = {
  ".mjs":  "application/javascript",
  ".js":   "application/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

/** Build-time: copy WASM/ONNX assets into dist/ so they're served at /ort/ and /vad/. */
function copyVoiceAssetsPlugin(): Plugin {
  return {
    name: "scrapalot-copy-voice-assets",
    apply: "build",
    async closeBundle() {
      const outDir = path.resolve(__dirname, "dist");
      for (const { src, dest } of VOICE_ASSETS) {
        const from = path.resolve(__dirname, src);
        const to = path.resolve(outDir, dest);
        try {
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(from, to);
        } catch (err) {
          console.warn(`[scrapalot-copy-voice-assets] skipped ${src} → ${dest}:`, (err as Error).message);
        }
      }
    },
  };
}

/**
 * Dev-time: serve WASM/ONNX assets directly from node_modules via Vite
 * middleware. Without this, `npm run dev` hits 404 on /ort/ and /vad/ because
 * copyVoiceAssetsPlugin only runs during `npm run build`.
 */
function serveVoiceAssetsPlugin(): Plugin {
  return {
    name: "scrapalot-serve-voice-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const match = VOICE_ASSETS.find(({ dest }) => url === `/${dest}`);
        if (!match) return next();
        try {
          const content = await fs.readFile(path.resolve(__dirname, match.src));
          const ext = path.extname(match.src);
          res.setHeader("Content-Type", EXT_MIME[ext] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(content);
        } catch {
          next();
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 3000,
    hmr: {
      overlay: false // This will hide HMR error overlays
    }
  },
  plugins: [
    react(),
    copyVoiceAssetsPlugin(),
    serveVoiceAssetsPlugin(),
    mode === 'development' &&
    componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    // Fix for sockjs-client and other libraries expecting Node.js globals
    global: 'window',
  },
  optimizeDeps: {
    esbuildOptions: {
      // Node.js global to browser globalThis
      define: {
        global: 'globalThis',
      },
    },
  },
  build: {
    sourcemap: 'hidden', // Hidden source maps - available for error tracking but not shipped to browser
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    chunkSizeWarningLimit: 3000, // Large app with many vendor deps, main chunk ~3MB
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor chunks for large libraries
          if (id.includes('node_modules')) {
            // PDF viewer
            if (id.includes('pdfjs-dist') || id.includes('@react-pdf-viewer')) {
              return 'pdf-vendor';
            }
            // Rich text editor
            if (id.includes('@tiptap')) {
              return 'editor-vendor';
            }
            // Charting/visualization
            if (id.includes('mermaid') || id.includes('d3-')) {
              return 'chart-vendor';
            }
            // Math rendering
            if (id.includes('katex')) {
              return 'katex-vendor';
            }
            // Graph visualization
            if (id.includes('cytoscape')) {
              return 'cytoscape-vendor';
            }
            // Radix UI
            if (id.includes('@radix-ui')) {
              return 'radix-vendor';
            }
            // Animation
            if (id.includes('framer-motion')) {
              return 'motion-vendor';
            }
          }
        },
      },
    },
  },
  base: mode === 'production' ? '/' : '/',
}));
