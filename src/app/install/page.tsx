import Image from "next/image";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";

export default async function InstallPage() {
  return (
    <>
      <PageHeader
        title="Install Snacky OS"
        subtitle="Set up Snacky OS as a mobile-friendly PWA for operators and managers."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <SectionCard>
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <Image src="/brand/snacky-logo.png" alt="Snacky logo" fill sizes="56px" className="object-contain" priority />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Install from your browser</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Snacky OS is ready to install when the browser shows its install option. Use it like a normal internal app after it is added to the home screen.
                </p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">iPhone / iPad</div>
                <ol className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                  <li>1. Open Snacky OS in Safari.</li>
                  <li>2. Tap Safari Share.</li>
                  <li>3. Choose Add to Home Screen.</li>
                  <li>4. Open Snacky from the new home-screen icon.</li>
                </ol>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">Android</div>
                <ol className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                  <li>1. Open Snacky OS in Chrome.</li>
                  <li>2. Tap Chrome Menu.</li>
                  <li>3. Choose Add to Home Screen or Install App.</li>
                  <li>4. Launch Snacky from the app icon.</li>
                </ol>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Desktop</h3>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Use the install icon in the browser address bar when it appears, or open the browser menu and choose Install Snacky OS.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">Operators</div>
                <p className="mt-1 text-sm text-slate-500">Install on phones used for route execution, pick lists, stop completion, cash entry, and issue reporting.</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">Managers</div>
                <p className="mt-1 text-sm text-slate-500">Install on tablets or laptops used for route planning, inventory review, and daily operating checks.</p>
              </div>
            </div>
          </div>
        </SectionCard>

        <EmptyState
          title="No installer prompt yet"
          body="The browser controls the install prompt. If it is hidden, keep using Snacky OS in the browser and try again after the app has loaded once online."
        />
      </div>
    </>
  );
}
