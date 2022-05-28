import fs from "fs";
import yenc from "simple-yenc";
import { deflateSync } from "fflate";

const shouldCompress = true;
const distPath = process.argv[2];
let decoder = fs.readFileSync(distPath, { encoding: "ascii" });

if (shouldCompress) {
  // only compile wasm once
  const wasmInstantiateMatcher = /WebAssembly\.instantiate\(.*?exports;/s;
  decoder = decoder.replace(
    decoder.match(wasmInstantiateMatcher)[0],
    "EmscriptenWASM.compiled.then((wasm) => WebAssembly.instantiate(wasm, imports)).then(function(instance) {\n var asm = instance.exports;"
  );

  const wasmBase64ContentMatcher =
    /Module\["wasm"\] = base64Decode\("(?<wasm>(.+))"\)/;
  const wasmBase64DeclarationMatcher = 'Module["wasm"] = base64Decode("';

  // original wasm
  const wasmContent = decoder.match(wasmBase64ContentMatcher).groups.wasm;
  // compressed buffer
  const wasmBuffer = Uint8Array.from(Buffer.from(wasmContent, "base64"));
  const wasmBufferCompressed = deflateSync(wasmBuffer, {
    level: 9,
    mem: 12,
  });

  // yEnc encoded wasm
  const dynEncodedSingleWasm = {
    wasm: yenc.dynamicEncode(wasmBufferCompressed, "'"),
    quote: "'",
  };
  const dynEncodedDoubleWasm = {
    wasm: yenc.dynamicEncode(wasmBufferCompressed, '"'),
    quote: '"',
  };
  const dynEncodedWasm =
    dynEncodedDoubleWasm.wasm.length > dynEncodedSingleWasm.wasm.length
      ? dynEncodedSingleWasm
      : dynEncodedDoubleWasm;

  // code before the wasm
  const wasmStartIdx = decoder.indexOf(wasmBase64DeclarationMatcher);

  // code after the wasm
  const wasmEndIdx =
    wasmStartIdx + wasmBase64DeclarationMatcher.length + wasmContent.length + 2;

  decoder = Buffer.concat(
    [
      decoder.substring(0, wasmStartIdx),
      'if (!EmscriptenWASM.compiled) Object.defineProperty(EmscriptenWASM, "compiled", {value: ',
      "WebAssembly.compile(WASMAudioDecoderCommon.inflateDynEncodeString(",
      dynEncodedWasm.quote,
      dynEncodedWasm.wasm,
      dynEncodedWasm.quote,
      `, new Uint8Array(${wasmBuffer.length})))})`,
      decoder.substring(wasmEndIdx),
    ].map(Buffer.from)
  );
}

const banner =
  "/* **************************************************\n" +
  " * This file is auto-generated during the build process.\n" +
  " * Any edits to this file will be overwritten.\n" +
  " ****************************************************/" +
  "\n\n";

// Concatenate the strings as buffers to preserve extended ascii
const finalString = Buffer.concat(
  [
    banner,
    "export default function EmscriptenWASM(WASMAudioDecoderCommon) {\n",
    decoder,
    "return this;\n",
    "}",
  ].map(Buffer.from)
);

fs.writeFileSync(distPath, finalString, { encoding: "binary" });
