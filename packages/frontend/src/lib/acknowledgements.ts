// Open-source libraries bundled into the Annex frontend, with their licenses.
// Keep in sync with the runtime `dependencies` in package.json.

export type Acknowledgement = {
  name: string;
  license: string;
  url: string;
};

export const ACKNOWLEDGEMENTS: Acknowledgement[] = [
  { name: "React", license: "MIT", url: "https://react.dev" },
  { name: "React Router", license: "MIT", url: "https://reactrouter.com" },
  { name: "CodeMirror", license: "MIT", url: "https://codemirror.net" },
  { name: "Lezer", license: "MIT", url: "https://lezer.codemirror.net" },
  { name: "Yjs", license: "MIT", url: "https://yjs.dev" },
  { name: "y-codemirror.next", license: "MIT", url: "https://github.com/yjs/y-codemirror.next" },
  { name: "y-protocols", license: "MIT", url: "https://github.com/yjs/y-protocols" },
  { name: "Excalidraw", license: "MIT", url: "https://excalidraw.com" },
  { name: "Mermaid", license: "MIT", url: "https://mermaid.js.org" },
  { name: "Shiki", license: "MIT", url: "https://shiki.style" },
  { name: "react-markdown", license: "MIT", url: "https://github.com/remarkjs/react-markdown" },
  { name: "remark-gfm", license: "MIT", url: "https://github.com/remarkjs/remark-gfm" },
  { name: "remark-breaks", license: "MIT", url: "https://github.com/remarkjs/remark-breaks" },
  { name: "remark-frontmatter", license: "MIT", url: "https://github.com/remarkjs/remark-frontmatter" },
  { name: "Radix UI", license: "MIT", url: "https://www.radix-ui.com" },
  { name: "lucide-react", license: "ISC", url: "https://lucide.dev" },
  { name: "cmdk", license: "MIT", url: "https://cmdk.paco.me" },
  { name: "sonner", license: "MIT", url: "https://sonner.emilkowal.ski" },
  { name: "input-otp", license: "MIT", url: "https://input-otp.rodz.dev" },
  { name: "react-day-picker", license: "MIT", url: "https://react-day-picker.js.org" },
  { name: "react-colorful", license: "MIT", url: "https://github.com/omgovich/react-colorful" },
  { name: "react-resizable-panels", license: "MIT", url: "https://github.com/bvaughn/react-resizable-panels" },
  { name: "react-qr-code", license: "MIT", url: "https://github.com/rosskhanas/react-qr-code" },
  { name: "react-force-graph-2d", license: "MIT", url: "https://github.com/vasturiano/react-force-graph" },
  { name: "class-variance-authority", license: "Apache-2.0", url: "https://cva.style" },
  { name: "tailwind-merge", license: "MIT", url: "https://github.com/dcastil/tailwind-merge" },
  { name: "clsx", license: "MIT", url: "https://github.com/lukeed/clsx" },
  { name: "Tailwind CSS", license: "MIT", url: "https://tailwindcss.com" },
  { name: "@tailwindcss/typography", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss-typography" },
  { name: "@simplewebauthn/browser", license: "MIT", url: "https://simplewebauthn.dev" },
  { name: "date-fns", license: "MIT", url: "https://date-fns.org" },
  { name: "culori", license: "MIT", url: "https://culorijs.org" },
  { name: "d3-geo", license: "ISC", url: "https://github.com/d3/d3-geo" },
  { name: "topojson-client", license: "ISC", url: "https://github.com/topojson/topojson-client" },
  { name: "world-atlas", license: "ISC", url: "https://github.com/topojson/world-atlas" },
  { name: "gifuct-js", license: "MIT", url: "https://github.com/matt-way/gifuct-js" },
  { name: "zxcvbn", license: "MIT", url: "https://github.com/dropbox/zxcvbn" },
  { name: "Vite", license: "MIT", url: "https://vite.dev" },
];
