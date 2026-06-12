// App shell: wires the radio socket, the audio player, and the UI store
// (lib/ui-store) into the three views — spectrum/waterfall, the live map, and
// the ISM console. View/layer changes that retune the server radio are
// orchestrated here; the chrome lives in components/AppChrome.

import { lazy, Suspense, useEffect } from "react";
import { DEFAULT_STATE, type MapLayer } from "@sdr/shared";
import { useRadio } from "@/lib/ws";
import { useAudioPlayer } from "@/lib/use-audio";
import { useUi, type Layers, type View } from "@/lib/ui-store";
import { SpectrumWaterfall } from "@/components/SpectrumWaterfall";
import { Controls } from "@/components/Controls";
import { Presets } from "@/components/Presets";
import { Bookmarks } from "@/components/Bookmarks";
import { Scanner } from "@/components/Scanner";
import { useBookmarks } from "@/lib/bookmarks";
import { Vfo } from "@/components/Vfo";
import { AdsbPanel, RefControls, AircraftDetail } from "@/components/AdsbPanel";
import { distanceNm } from "@/lib/geo";
import { AisPanel } from "@/components/AisPanel";
import { AprsPanel } from "@/components/AprsPanel";
import { Section } from "@/components/Controls";
import { IsmPanel } from "@/components/IsmPanel";
import { IsmConsole } from "@/components/IsmConsole";
import { RdsPanel } from "@/components/RdsPanel";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { SpectrumDisplay } from "@/components/SpectrumDisplay";
import {
  AudioControl,
  LAYER_LABEL,
  LayerToggle,
  StatusBar,
  ViewTabs,
} from "@/components/AppChrome";
import { AlertTriangle } from "lucide-react";

// OpenLayers is heavy; only load the map when the tracking view is opened.
const AdsbMap = lazy(() =>
  import("@/components/AdsbMap").then((m) => ({ default: m.AdsbMap })),
);

export default function App() {
  const radio = useRadio();
  const audio = useAudioPlayer(radio.subscribeAudio);
  const ui = useUi();
  const { view, layers, selected, receiverRef, display } = ui;
  const bm = useBookmarks();

  const state = radio.state ?? DEFAULT_STATE;

  // The selected aircraft, surfaced as a floating detail card over the map.
  const selAircraft =
    view === "track" && layers.adsb && selected
      ? radio.aircraft.find((a) => a.icao === selected)
      : undefined;
  const selDist =
    selAircraft && receiverRef && selAircraft.lat != null
      ? distanceNm(
          receiverRef.lat,
          receiverRef.lon,
          selAircraft.lat,
          selAircraft.lon!,
        )
      : null;

  const sendLayer = (l: MapLayer, on: boolean) => {
    if (l === "adsb") radio.send({ type: "setAdsb", on });
    else if (l === "ais") radio.send({ type: "setAis", on });
    else radio.send({ type: "setAprs", on });
  };

  // Push every layer's enabled state to the server (it round-robins the dongle
  // across the enabled bands and shows them together on the map).
  const activateLayers = (ls: Layers) => {
    sendLayer("adsb", ls.adsb);
    sendLayer("ais", ls.ais);
    sendLayer("aprs", ls.aprs);
  };

  const allLayersOff = () => {
    sendLayer("adsb", false);
    sendLayer("ais", false);
    sendLayer("aprs", false);
  };

  const switchView = (v: View) => {
    ui.setView(v);
    if (v === "track") {
      radio.send({ type: "setIsm", on: false });
      activateLayers(layers);
    } else if (v === "ism") {
      allLayersOff();
      radio.send({ type: "setIsm", on: true });
    } else {
      // Spectrum: leave every decode mode.
      allLayersOff();
      radio.send({ type: "setIsm", on: false });
    }
  };

  // Toggle one map layer on/off (layers display together).
  const toggleLayer = (l: MapLayer) => {
    const next = ui.toggleLayer(l);
    sendLayer(l, next[l]);
  };

  // Keep the server's reference position in sync (also re-sent on reconnect).
  const { send, connected } = radio;
  useEffect(() => {
    send({
      type: "setAdsbRef",
      lat: receiverRef?.lat ?? null,
      lon: receiverRef?.lon ?? null,
    });
  }, [send, connected, receiverRef]);

  // Flush buffered audio when retuning / changing mode to keep latency low.
  useEffect(() => {
    audio.flush();
  }, [audio.flush, state.mode, state.centerHz]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {radio.error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" /> {radio.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Control rail — receiver controls, or traffic when in the map view */}
        <aside className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-r bg-sidebar">
          {view === "track" ? (
            <>
              <div className="border-b p-2">
                <LayerToggle
                  layers={layers}
                  activeLayer={state.activeLayer}
                  onToggle={toggleLayer}
                />
              </div>
              <Section title="Receiver location" defaultOpen={!receiverRef}>
                <RefControls
                  refLat={receiverRef?.lat ?? null}
                  refLon={receiverRef?.lon ?? null}
                  onSetRef={ui.setReceiverRef}
                  hasRef={receiverRef != null}
                />
              </Section>
              {!layers.adsb && !layers.ais && !layers.aprs && (
                <p className="px-4 py-3 text-[11px] text-muted-foreground">
                  No layers enabled. Turn on Aircraft, Ships or APRS above to
                  start decoding.
                </p>
              )}
              {layers.adsb && (
                <AdsbPanel
                  aircraft={radio.aircraft}
                  messageRate={radio.messageRate}
                  selected={selected}
                  onSelect={ui.setSelected}
                  refLat={receiverRef?.lat ?? null}
                  refLon={receiverRef?.lon ?? null}
                  onSetRef={ui.setReceiverRef}
                  hideRef
                />
              )}
              {layers.ais && (
                <AisPanel
                  vessels={radio.vessels}
                  messageRate={radio.aisMessageRate}
                  framesSeen={radio.aisFramesSeen}
                  selected={selected}
                  onSelect={ui.setSelected}
                  refLat={receiverRef?.lat ?? null}
                  refLon={receiverRef?.lon ?? null}
                  onSetRef={ui.setReceiverRef}
                  hideRef
                />
              )}
              {layers.aprs && (
                <AprsPanel
                  stations={radio.stations}
                  messageRate={radio.aprsMessageRate}
                  framesSeen={radio.aprsFramesSeen}
                  selected={selected}
                  onSelect={ui.setSelected}
                  refLat={receiverRef?.lat ?? null}
                  refLon={receiverRef?.lon ?? null}
                  onSetRef={ui.setReceiverRef}
                  hideRef
                />
              )}
            </>
          ) : view === "ism" ? (
            <IsmPanel
              stats={radio.ismStats}
              ismFreqHz={state.ismFreqHz}
              send={radio.send}
            />
          ) : (
            <>
              <Presets state={state} send={radio.send} />
              <Scanner
                state={state}
                send={radio.send}
                scan={radio.scan}
                bookmarks={bm.items}
              />
              <Bookmarks state={state} send={radio.send} bm={bm} />
              <Controls
                state={state}
                deviceInfo={radio.deviceInfo}
                signal={radio.signal}
                send={radio.send}
              />
              <SpectrumDisplay display={display} onChange={ui.setDisplay} />
            </>
          )}
        </aside>

        {/* Main column: view tabs + spectrum/waterfall or live ADS-B map */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b px-4 py-2">
            <ViewTabs
              view={view}
              onChange={switchView}
              ismAvailable={state.ismAvailable}
            />
            {view === "track" && (
              <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>
                  {[
                    layers.adsb && `${radio.aircraft.length} aircraft`,
                    layers.ais && `${radio.vessels.length} ships`,
                    layers.aprs && `${radio.stations.length} stations`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "no layers enabled"}
                </span>
                {state.activeLayer && (
                  <span className="flex items-center gap-1 text-primary/80">
                    <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                    {LAYER_LABEL[state.activeLayer]}
                  </span>
                )}
              </span>
            )}
            {view === "ism" && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {radio.ismStats?.decoded ?? 0} decoded ·{" "}
                {radio.ismStats?.bursts ?? 0} bursts
              </span>
            )}
            {view === "spectrum" && (
              <AudioControl
                running={audio.running}
                volume={audio.volume}
                muted={audio.muted}
                onVolume={audio.changeVolume}
                onToggleMute={audio.toggleMute}
                onEnable={audio.enable}
              />
            )}
          </div>
          {view === "spectrum" ? (
            <>
              <div className="border-b px-4 py-2.5">
                <Vfo state={state} send={radio.send} />
              </div>
              <div className="min-h-0 flex-1 p-4">
                <SpectrumWaterfall
                  subscribeFft={radio.subscribeFft}
                  state={state}
                  display={display}
                  onTune={(hz) => radio.send({ type: "setVfoOffset", hz })}
                  onPassband={(low, high) =>
                    radio.send({ type: "setPassband", low, high })
                  }
                  onNotches={(notches) =>
                    radio.send({ type: "setNotches", notches })
                  }
                />
              </div>
            </>
          ) : view === "track" ? (
            <div className="relative min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading map…
                  </div>
                }
              >
                <AdsbMap
                  aircraft={layers.adsb ? radio.aircraft : []}
                  vessels={layers.ais ? radio.vessels : []}
                  stations={layers.aprs ? radio.stations : []}
                  selected={selected}
                  onSelect={ui.setSelected}
                  refLat={receiverRef?.lat ?? null}
                  refLon={receiverRef?.lon ?? null}
                />
              </Suspense>
              {selAircraft && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-end justify-end p-4">
                  <div className="pointer-events-auto">
                    <AircraftDetail
                      key={selAircraft.icao}
                      report={selAircraft}
                      dist={selDist}
                      onClose={() => ui.setSelected(null)}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <IsmConsole
                events={radio.ismEvents}
                freqHz={radio.ismStats?.freqHz ?? state.ismFreqHz}
              />
            </div>
          )}
        </main>

        {/* Read rail — decoded output (RDS, transcript), kept apart from the
            control rail so live data never scrolls away behind settings. */}
        {view === "spectrum" && (
          <aside className="flex w-[300px] shrink-0 flex-col border-l bg-sidebar">
            <RdsPanel
              station={radio.rdsStation}
              stats={radio.rdsStats}
              mode={state.mode}
            />
            <TranscriptPanel
              segments={radio.transcripts}
              on={state.transcribe}
              available={state.transcribeAvailable}
              model={state.transcribeModel}
              models={state.transcribeModels}
              status={state.transcribeStatus}
              send={radio.send}
            />
          </aside>
        )}
      </div>

      <StatusBar
        state={state}
        audioRunning={audio.running}
        view={view}
        layers={layers}
      />
    </div>
  );
}
