// Settings (2026-10-22): the settings themselves, plus the three pages that
// used to sit in the sidebar — the live log, About and the legal documents —
// and, since 2026-10-25, the Guides (the tutorial videos).

import { TabbedPage } from '../components/common';
import { useNav } from '../state/nav';
import { SettingsPage } from './Settings';
import { GuidesPage } from './Guides';
import { Console } from './Console';
import { About } from './About';
import { LegalPage } from './Legal';

export function SettingsHub() {
  const nav = useNav();
  // The tab lives in the navigation state, so the gear in the bar always
  // lands on Settings — even from Settings › Legal.
  const tab = nav.settingsTab;
  return (
    <TabbedPage
      title="Settings"
      value={tab}
      onChange={(t) => nav.go('settings', { settingsTab: t })}
      tabs={[
        { value: 'general', label: 'Settings' },
        { value: 'guides', label: 'Guides' },
        { value: 'console', label: 'Log' },
        { value: 'about', label: 'About' },
        { value: 'legal', label: 'Legal' },
      ]}
    >
      {tab === 'general' && <SettingsPage />}
      {tab === 'guides' && <GuidesPage />}
      {tab === 'console' && <Console />}
      {tab === 'about' && <About />}
      {tab === 'legal' && <LegalPage />}
    </TabbedPage>
  );
}
