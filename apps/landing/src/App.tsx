import { LINKS } from "./config";

export default function App() {
  return (
    <div className="min-h-screen flex flex-col items-center pt-24 pb-12 bg-black text-white px-4">
      <header className="absolute top-0 left-0 p-4">
        <img
          src="/brand/logo-primary.png"
          alt="Pulse Alpha"
          className="h-10 w-auto object-contain object-left"
        />
      </header>

      <main className="flex flex-col items-center text-center max-w-3xl w-full">
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-6">
          Find the Bags launches worth watching before they move.
        </h1>
        <p className="text-lg text-gray-400 max-w-xl mx-auto mb-8">
          Dev wallet scoring and Bags launch signals. Straight to Telegram.
        </p>

        <a
          href={LINKS.telegram}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 bg-[#00ff00] text-black font-bold text-lg px-8 py-4 rounded-lg hover:bg-green-400 transition-colors mb-8 shadow-[0_0_15px_rgba(0,255,0,0.5)]"
        >
          Open Telegram Bot
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </a>

        <div className="max-w-md w-full mx-auto rounded-2xl overflow-hidden">
          <img
            src="/hero/bot-mockup.png"
            alt="Telegram Bot Interface"
            className="w-full object-contain"
          />
        </div>

        <div className="w-full max-w-md mt-4 bg-[#0a0a0a] border border-gray-800 rounded-lg p-6 font-mono text-sm text-gray-400 text-left">
          <div className="text-gray-600 mb-4 border-b border-gray-800 pb-2">
            Available Commands:
          </div>
          <div className="mb-3">
            <span className="text-[#00ff00]">/top_candidates</span>
            <span className="text-gray-400"> - Launch and alpha signals.</span>
          </div>
          <div className="mb-3">
            <span className="text-[#00ff00]">/mint</span>
            <span className="text-gray-400"> - Query any mint for Bags context.</span>
          </div>
          <div className="mb-3">
            <span className="text-[#00ff00]">/follow</span>
            <span className="text-gray-400"> - Follow mints for automatic alerts.</span>
          </div>
        </div>

        <footer className="mt-16 w-full flex flex-col items-center gap-4 text-sm text-gray-600 pb-8">
          <div className="flex gap-8">
            <a
              href={LINKS.telegram}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#00ff00] transition-colors"
            >
              Telegram
            </a>
            <a
              href={LINKS.github}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#00ff00] transition-colors"
            >
              GitHub
            </a>
          </div>
          <div>© 2026 Pulse Alpha. All rights reserved.</div>
        </footer>
      </main>
    </div>
  );
}
