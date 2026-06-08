declare module "fft.js" {
  export default class FFT {
    constructor(size: number);
    readonly size: number;
    createComplexArray(): number[];
    /** Forward transform; `input` is interleaved complex [re, im, ...]. */
    transform(out: number[] | Float64Array, input: ArrayLike<number>): void;
    /** Forward transform from a real input of length `size`. */
    realTransform(out: number[] | Float64Array, input: ArrayLike<number>): void;
    inverseTransform(out: number[] | Float64Array, input: ArrayLike<number>): void;
    completeSpectrum(spectrum: number[] | Float64Array): void;
    fromComplexArray(complex: ArrayLike<number>, storage?: number[]): number[];
    toComplexArray(input: ArrayLike<number>, storage?: number[]): number[];
  }
}
