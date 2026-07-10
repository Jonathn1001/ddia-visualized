import { PingPongLab } from './labs/pingpong/PingPongLab';

export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">DDIA Visualized</h1>
        <p className="text-slate-400">Phase 1 — Lab Kit</p>
      </header>
      <PingPongLab />
    </main>
  );
}
