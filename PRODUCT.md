# Product

## Register

product

## Users

Licensed hams and RF hobbyists who already speak SDR: modes (WFM/NFM/AM/USB/LSB/CW),
squelch, ppm correction, direct sampling, bias tee. They sit at a desk, often in low
light, working a single screen to dial in a signal and listen. They know what a
waterfall is and expect the controls to behave the way SDR#, GQRX, and SDR++ taught
them. They are operating an instrument, not browsing an app.

## Product Purpose

A web SDR receiver for the RTL-SDR Blog V3 dongle. The Bun backend drives `rtl_tcp`
and runs the DSP (FFT spectrum + demodulation); the browser renders the
spectrum/waterfall and plays demodulated audio in real time. Success is a user who can
tune, identify a signal on the waterfall, pick the right mode and bandwidth, and hear
clean audio without thinking about the interface. The screen's job is to make the radio
legible: accurate readouts, responsive tuning, no friction between intent and signal.

## Brand Personality

Precision instrument. Calm, exact, the quiet authority of bench test gear and a
well-made receiver. Three words: **exact, legible, unobtrusive**. The tone of readouts
and labels is plain and technical, never cute. Confidence comes from trustworthy
numbers and controls that land where the hand expects them, not from decoration. The
real-time life of the waterfall is the only thing allowed to feel alive; everything
around it holds still.

## Anti-references

- **Consumer / toy radio apps**: rounded playful chrome, oversized friendly buttons,
  gamified flourishes. This is a receiver, not a phone toy.
- **Generic SaaS dashboards**: card-grid templates, gradient hero-metric panels,
  marketing-speak. No dashboard scaffolding for its own sake.
- **Cluttered legacy SDR utilities**: the cramped every-pixel-packed Windows-tool look.
  Density is welcome; chaos is not. Dense and ordered, never dense and noisy.

Reference qualities to borrow (not clone): from **SDR# / GQRX / SDR++**, honor the
conventions hams already have in muscle memory (mode vocabulary, click-to-tune
spectrum, classic waterfall reading). From **terminal / monitoring UIs**, take
information density, monospace numerics, and real-time data as the centerpiece.

## Design Principles

1. **The signal is the hero.** The spectrum and waterfall own the screen; chrome
   recedes. Every other element earns its space against that.
2. **Numbers are trustworthy.** Frequencies, dB readouts, and bandwidths are exact,
   monospace, and stable — no jitter, no rounding that hides what the radio is doing.
3. **Honor muscle memory.** Match the conventions of established SDR tools so a ham is
   fluent on first sight. Invent only where it clearly beats the convention.
4. **Dense but ordered.** Pack real information; never pack noise. Grouping and rhythm
   carry the density so it reads as an instrument panel, not a cluttered utility.
5. **Stillness around motion.** Only the live data moves. Decoration that competes with
   the waterfall for attention is removed.

## Accessibility & Inclusion

- **Contrast: WCAG AA in the dark theme.** Body and label text ≥4.5:1 against their
  surfaces; readouts legible at a glance in low light. No muted-gray text that fails on
  the near-black panels.
- **Reduced motion**: honor `prefers-reduced-motion`. The waterfall and meters stay
  usable with animation reduced — no disorienting choreography is required to read the
  radio.
- **Colorblind-aware waterfall**: spectrum/waterfall color maps should not depend on
  red–green discrimination alone; a colorblind-safe map is a wanted option (not yet
  confirmed as a hard requirement).
- **Keyboard control** for core tuning, mode, and squelch is a desirable goal so the
  spectrum isn't mouse-only.
