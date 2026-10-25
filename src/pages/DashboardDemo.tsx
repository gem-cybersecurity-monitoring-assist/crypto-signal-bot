import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, ArrowLeft, ArrowRight, AudioLines, CheckCircle2, CirclePlay,
  Clock3, Gauge, Pause, Play, RotateCcw, ShieldCheck, SkipBack, SkipForward,
  Wallet, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

type Scene = {
  eyebrow: string;
  title: string;
  summary: string;
  narration: string;
  duration: string;
  visual: 'overview' | 'signal' | 'risk' | 'position' | 'audit';
  bullets: string[];
};

const scenes: Scene[] = [
  {
    eyebrow: '01 / ORIENTATION',
    title: 'Start in practice mode',
    summary: 'See the account state before you do anything.',
    narration: 'Welcome to Crypto Signal Bot. This guided preview uses sample values only. Practice mode: no real money. Live execution, mainnet transactions, and withdrawals stay disabled.',
    duration: '00:00–00:18',
    visual: 'overview',
    bullets: ['Practice mode: no real money', 'Sample wallet: 10,000 USDT', 'Live execution and withdrawals locked'],
  },
  {
    eyebrow: '02 / MARKET SIGNAL',
    title: 'Read the signal first',
    summary: 'Review direction and confidence before considering an entry.',
    narration: 'Choose a market such as BTC USDT. Read the signal direction and confidence, then review the market context. A neutral or HOLD signal is not an invitation to trade.',
    duration: '00:18–00:38',
    visual: 'signal',
    bullets: ['Market: BTC / USDT', 'Example signal: BUY · 78% confidence', 'A HOLD signal blocks entry'],
  },
  {
    eyebrow: '03 / RISK GATE',
    title: 'Let Guardian check the risk',
    summary: 'The server must approve the paper intent before it can proceed.',
    narration: 'Before a paper entry, the risk gate checks the current signal, Guardian state, available equity, and drawdown. The illustrative sizing limit is about two percent of net asset value. If required data is unavailable, the action must fail closed.',
    duration: '00:38–01:02',
    visual: 'risk',
    bullets: ['Guardian must be clear', 'Illustrative entry cap: about 2% of equity', 'Unavailable checks mean no trade'],
  },
  {
    eyebrow: '04 / PAPER POSITION',
    title: 'Practice the position lifecycle',
    summary: 'Explore the buy-to-open and sell-to-close sequence without sending orders.',
    narration: 'In the real paper workflow, the server authorizes a paper entry and the portfolio reflects the position. Selling closes an existing paper position. This preview does not submit any order or change your account.',
    duration: '01:02–01:28',
    visual: 'position',
    bullets: ['Example notional: 200 USDT', 'Position status: illustrative only', 'No API calls or orders are sent'],
  },
  {
    eyebrow: '05 / PORTFOLIO & AUDIT',
    title: 'Finish with evidence',
    summary: 'Check the portfolio, activity, and safety status.',
    narration: 'Finish by reviewing the portfolio and audit trail. Confirm that the activity matches the actions you intended. Guardian has an emergency stop threshold configured for the product; this preview does not change live settings.',
    duration: '01:28–01:48',
    visual: 'audit',
    bullets: ['Review balance and open positions', 'Inspect activity and audit evidence', 'Guardian emergency stop: 15% loss threshold'],
  },
];

function MockPanel({ scene }: { scene: Scene }) {
  const [demoPosition, setDemoPosition] = useState(false);
  const [notice, setNotice] = useState('');
  const stats = useMemo(() => [
    { label: 'Paper equity', value: '$10,000.00' },
    { label: 'Open positions', value: demoPosition ? '1 (sample)' : '0' },
    { label: 'Guardian', value: 'NOMINAL' },
  ], [demoPosition]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-100">
          <Activity className="h-4 w-4 text-cyan-300" /> CRYPTO SIGNAL BOT
        </div>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[10px] font-bold tracking-wider text-amber-200">PAPER / TESTNET</span>
      </div>
      <div className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-center text-xs font-bold tracking-wide text-amber-100">
        PRACTICE MODE: NO REAL MONEY
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-400">{stat.label}</p>
            <p className="mt-2 text-sm font-semibold text-slate-100">{stat.value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 p-4 pt-0 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-400">Selected market</p><h3 className="mt-1 text-lg font-bold text-white">BTC / USDT</h3></div>
            <span className="rounded-md bg-cyan-400/10 px-2 py-1 text-xs font-bold text-cyan-200">SAMPLE DATA</span>
          </div>
          <div className="my-5 flex h-24 items-end gap-1">
            {[32, 42, 36, 48, 43, 61, 54, 69, 58, 76, 68, 83, 72, 91, 80, 87, 70, 78, 94, 86, 98, 89, 100, 92].map((h, i) => (
              <div key={i} style={{ height: `${h}%` }} className={`flex-1 rounded-t-sm ${i % 5 === 0 ? 'bg-amber-300/80' : 'bg-cyan-400/70'}`} />
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-slate-800 pt-3">
            <div><p className="text-xs text-slate-400">Illustrative signal</p><p className="mt-1 text-sm font-bold text-emerald-300">BUY · 78% confidence</p></div>
            <div className="text-right"><p className="text-xs text-slate-400">Reference price</p><p className="mt-1 text-sm font-semibold text-white">$67,420.00</p></div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Guardian risk gate</div>
          <div className="mt-4 space-y-3">
            {[['Signal freshness', 'PASS'], ['Guardian status', 'CLEAR'], ['Equity & drawdown', 'PASS']].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-xs"><span className="text-slate-400">{label}</span><span className="font-bold text-emerald-300">{value}</span></div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950/80 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-400">Maximum example entry</p>
            <p className="mt-1 text-xl font-bold text-white">$200.00 <span className="text-xs font-normal text-slate-400">USDT</span></p>
            <p className="mt-1 text-[10px] text-slate-500">2% of sample equity · not an order</p>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => { setDemoPosition(true); setNotice('Sample position shown — no order sent.'); }} className="flex-1 bg-emerald-600 text-white hover:bg-emerald-500"><Wallet className="mr-1 h-3.5 w-3.5" /> Preview buy</Button>
            <Button size="sm" variant="outline" onClick={() => { setDemoPosition(false); setNotice('Sample position cleared — no order sent.'); }} className="flex-1 border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700"><X className="mr-1 h-3.5 w-3.5" /> Preview sell</Button>
          </div>
          {notice && <p role="status" className="mt-3 text-[11px] text-cyan-200">{notice}</p>}
        </div>
      </div>
      <div className="mx-4 mb-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
        <div className="mb-3 flex items-center justify-between"><p className="text-xs font-semibold text-slate-200">Recent activity · example</p><span className="text-[10px] text-slate-500">DEMO DATA</span></div>
        {[
          ['12:04:18', scene.visual === 'audit' ? 'Audit event reviewed' : 'Signal snapshot refreshed', 'INFO'],
          ['12:04:16', scene.visual === 'risk' ? 'Risk checks passed (sample)' : 'Guardian status: nominal', 'SAFE'],
          ['12:04:12', demoPosition ? 'Sample position previewed' : 'No paper order submitted', 'PAPER'],
        ].map(([time, label, tag]) => <div key={time + label} className="flex flex-wrap items-center gap-3 border-t border-slate-800 py-2 text-[11px]"><span className="font-mono text-slate-500">{time}</span><span className="flex-1 text-slate-300">{label}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-cyan-200">{tag}</span></div>)}
      </div>
    </div>
  );
}

export default function DashboardDemo() {
  const navigate = useNavigate();
  const [sceneIndex, setSceneIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [view, setView] = useState<'preview' | 'guided'>('preview');
  const scene = scenes[sceneIndex];

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (sceneIndex >= scenes.length - 1) setPlaying(false);
      else setSceneIndex((current) => current + 1);
    }, 8500);
    return () => window.clearTimeout(timer);
  }, [playing, sceneIndex]);

  useEffect(() => {
    if (!playing || !voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(scene.narration);
    utterance.rate = 0.96;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [playing, voiceEnabled, scene]);

  useEffect(() => () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const goToScene = (index: number) => {
    setSceneIndex(Math.max(0, Math.min(scenes.length - 1, index)));
    setPlaying(false);
  };

  return (
    <main className="min-h-screen bg-[#070b13] text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/90 bg-[#070b13]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3"><div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-2"><Activity className="h-5 w-5 text-cyan-200" /></div><div><p className="text-sm font-bold tracking-wide">DASHBOARD DEMO STUDIO</p><p className="text-[11px] text-slate-400">Video preview + guided walkthrough</p></div></div>
          <Button variant="outline" onClick={() => navigate('/dashboard')} className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"><ArrowLeft className="mr-2 h-4 w-4" /> Dashboard</Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div><p className="font-mono text-[10px] tracking-[0.28em] text-cyan-300">CRYPTO SIGNAL BOT / DEMO MODE</p><h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">See the workflow before you run it.</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">A narrated, scene-based preview plus clickable walkthrough. All values and actions on this page are illustrative and isolated from your trading account.</p></div>
          <div className="flex rounded-xl border border-slate-800 bg-slate-900 p-1"><button onClick={() => setView('preview')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'preview' ? 'bg-cyan-300 text-slate-950' : 'text-slate-400 hover:text-white'}`}><CirclePlay className="mr-2 inline h-4 w-4" /> Video preview</button><button onClick={() => { setView('guided'); setPlaying(false); }} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'guided' ? 'bg-cyan-300 text-slate-950' : 'text-slate-400 hover:text-white'}`}><Activity className="mr-2 inline h-4 w-4" /> Guided demo</button></div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.8fr)]">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3"><span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[10px] font-bold tracking-widest text-cyan-200">{scene.eyebrow}</span><span className="flex items-center gap-1.5 text-xs text-slate-400"><Clock3 className="h-3.5 w-3.5" /> {scene.duration}</span></div>
            <MockPanel key={sceneIndex} scene={scene} />
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="text-lg font-bold">{scene.title}</h2><p className="mt-1 text-sm text-slate-400">{scene.summary}</p></div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => { setPlaying(false); setSceneIndex(0); }} className="border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800" title="Restart preview"><RotateCcw className="h-4 w-4" /></Button>
                  <Button variant="outline" onClick={() => setVoiceEnabled((v) => !v)} className="border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800" title={voiceEnabled ? 'Turn narration off' : 'Turn narration on'}><AudioLines className="mr-2 h-4 w-4" /> {voiceEnabled ? 'Voice on' : 'Voice off'}</Button>
                  {playing ? <Button onClick={() => setPlaying(false)} className="bg-cyan-300 text-slate-950 hover:bg-cyan-200"><Pause className="mr-2 h-4 w-4" /> Pause</Button> : <Button onClick={() => { if (sceneIndex === scenes.length - 1) setSceneIndex(0); setPlaying(true); }} className="bg-cyan-300 text-slate-950 hover:bg-cyan-200"><Play className="mr-2 h-4 w-4" /> Play preview</Button>}
                </div>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-cyan-300 transition-all duration-500" style={{ width: `${((sceneIndex + 1) / scenes.length) * 100}%` }} /></div>
              <div className="mt-4 flex items-center justify-between"><Button variant="ghost" disabled={sceneIndex === 0} onClick={() => goToScene(sceneIndex - 1)} className="text-slate-300 hover:bg-slate-800 hover:text-white"><SkipBack className="mr-2 h-4 w-4" /> Previous</Button><span className="text-xs text-slate-500">Scene {sceneIndex + 1} of {scenes.length}</span><Button variant="ghost" disabled={sceneIndex === scenes.length - 1} onClick={() => goToScene(sceneIndex + 1)} className="text-slate-300 hover:bg-slate-800 hover:text-white">Next <SkipForward className="ml-2 h-4 w-4" /></Button></div>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4"><p className="mb-2 text-[10px] font-bold tracking-[0.22em] text-slate-500">NARRATION SCRIPT</p><p className="text-sm leading-6 text-slate-300">{scene.narration}</p></div>
          </section>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5"><div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-cyan-200" /><h2 className="font-semibold">Walkthrough chapters</h2></div><div className="mt-4 space-y-2">{scenes.map((item, index) => <button key={item.eyebrow} onClick={() => goToScene(index)} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${index === sceneIndex ? 'border-cyan-300/40 bg-cyan-300/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'}`}><span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${index === sceneIndex ? 'bg-cyan-300 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>{index < sceneIndex ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span><span><span className="block text-sm font-semibold text-slate-100">{item.title}</span><span className="mt-1 block text-xs leading-5 text-slate-400">{item.summary}</span></span></button>)}</div></div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5"><h2 className="font-semibold">Chapter checklist</h2><div className="mt-3 space-y-3">{scene.bullets.map((item, index) => <div key={item} className="flex gap-2.5 text-sm text-slate-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />{item}</div>)}</div></div>
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4"><div className="flex items-center gap-2 text-amber-200"><ShieldCheck className="h-4 w-4" /><p className="text-xs font-bold tracking-widest">SAFETY BOUNDARY</p></div><p className="mt-2 text-xs leading-5 text-amber-100/80">This demo is not connected to the trade API. Buttons change only the sample display. Live execution, mainnet, and withdrawals remain disabled. No credentials or API keys are requested.</p></div>
          </aside>
        </div>
        <footer className="mt-8 flex flex-col gap-3 border-t border-slate-800 pt-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between"><span>Crypto Signal Bot · Demo Studio · Sample data only</span><button onClick={() => navigate('/dashboard')} className="inline-flex items-center gap-2 font-semibold text-cyan-200 hover:text-white">Return to dashboard <ArrowRight className="h-3.5 w-3.5" /></button></footer>
      </div>
    </main>
  );
}
