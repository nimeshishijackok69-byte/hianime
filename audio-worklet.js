class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSamples = Math.max(
      160,
      Math.round(this.targetSampleRate * (processorOptions.chunkMs || 40) / 1000)
    );
    this.sampleStep = sampleRate / this.targetSampleRate;
    this.nextOutputIndex = 0;
    this.inputIndex = 0;
    this.lastMonoSample = 0;
    this.hasLastSample = false;
    this.pendingBuffer = new Int16Array(this.chunkSamples);
    this.pendingCount = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (output?.[0]) {
      output[0].fill(0);
    }

    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const frameLength = input[0].length;
    for (let i = 0; i < frameLength; i += 1) {
      let monoSample = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        monoSample += input[channel][i] || 0;
      }
      monoSample /= input.length;

      if (!this.hasLastSample) {
        this.lastMonoSample = monoSample;
        this.hasLastSample = true;
        this.inputIndex += 1;
        continue;
      }

      while (this.nextOutputIndex <= this.inputIndex) {
        const fraction = this.nextOutputIndex - (this.inputIndex - 1);
        const interpolated = this.lastMonoSample + (monoSample - this.lastMonoSample) * fraction;
        this.pendingBuffer[this.pendingCount] = this.floatToInt16(interpolated);
        this.pendingCount += 1;

        if (this.pendingCount === this.chunkSamples) {
          this.flushChunk();
        }

        this.nextOutputIndex += this.sampleStep;
      }

      this.lastMonoSample = monoSample;
      this.inputIndex += 1;
    }

    return true;
  }

  floatToInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  flushChunk() {
    const buffer = new ArrayBuffer(this.chunkSamples * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < this.chunkSamples; i += 1) {
      view.setInt16(i * 2, this.pendingBuffer[i], true);
    }

    this.pendingCount = 0;

    this.port.postMessage({
      type: "PCM_CHUNK",
      buffer
    }, [buffer]);
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
