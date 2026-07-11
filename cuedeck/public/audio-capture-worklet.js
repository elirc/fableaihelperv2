/**
 * CueDeck capture worklet. Downmixes each 128-frame render quantum to mono
 * and posts it to the main thread with its RMS/peak level. Runs on the
 * audio rendering thread (CAP-07: AudioWorklet, not ScriptProcessorNode).
 */
class CueDeckCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const channels = input.length;
      const frames = input[0].length;
      const mono = new Float32Array(frames);
      for (let c = 0; c < channels; c++) {
        const channel = input[c];
        for (let i = 0; i < frames; i++) {
          mono[i] += channel[i] / channels;
        }
      }
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const s = mono[i];
        sumSquares += s * s;
        const abs = s < 0 ? -s : s;
        if (abs > peak) peak = abs;
      }
      this.port.postMessage({ samples: mono, rms: Math.sqrt(sumSquares / frames), peak }, [
        mono.buffer,
      ]);
    }
    return true;
  }
}

registerProcessor('cuedeck-capture', CueDeckCaptureProcessor);
