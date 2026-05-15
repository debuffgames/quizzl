export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-6">🎯</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-3">Quizzl</h1>
        <p className="text-gray-600 text-lg mb-8">
          Quizzl ist ein integriertes Quiz-Modul und kann nur über die Lernspielplattform genutzt werden.
        </p>
        <a
          href="https://dinoschule.de"
          className="inline-block bg-indigo-600 text-white font-semibold px-8 py-3 rounded-xl hover:bg-indigo-700 transition-colors"
        >
          Zu dinoschule.de
        </a>
      </div>
    </div>
  );
}
