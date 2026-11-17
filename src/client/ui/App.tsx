import Router from 'preact-router';
import { Suspense } from 'preact/compat';
import { DocRoute } from './DocRoute';
import { Home } from './home/Home';
import { lazyView } from './common/lazy-view';
import { hashHistory } from './hash-history';
import { Notifications } from './components/Notifications';
import { Toaster } from './components/ui/toast';
import { useResetRequired } from './worker-api';

// Every route except the landing page and the (tiny) doc dispatcher is
// code-split; preact-router matches on the vnode's `path` attribute, so lazy
// components work unchanged.
const Settings = lazyView(() => import('./settings/Settings').then(m => m.Settings));
const SettingsSection = lazyView(() => import('./settings/SettingsSection').then(m => m.SettingsSection));
const Friends = lazyView(() => import('./friends/Friends').then(m => m.Friends));
const LinkDevicePage = lazyView(() => import('./settings/LinkDevicePage').then(m => m.LinkDevicePage));
const AddFriendPage = lazyView(() => import('./settings/AddFriendPage').then(m => m.AddFriendPage));
const AllCalendars = lazyView(() => import('./doc-plugins/calendar/AllCalendars').then(m => m.AllCalendars));
const SourceViewer = lazyView(() => import('./source/SourceViewer').then(m => m.SourceViewer));
const SharingPage = lazyView(() => import('./sharing/SharingPage').then(m => m.SharingPage));
const ResetRequiredPage = lazyView(() => import('./settings/ResetRequiredPage').then(m => m.ResetRequiredPage));

export function App() {
  // The saved keyhive state is from an older version: the engine booted nothing,
  // so no route has anything to show. The reset screen replaces the router
  // outright (whatever the URL), and reloads the app when it is done.
  // Notifications stays mounted so a newer build can still be picked up.
  const resetRequired = useResetRequired();

  return (
    <>
    <Notifications />
    <Toaster />
    <Suspense fallback={
      <div className="flex justify-center mt-24">
        <span className="material-symbols-outlined animate-spin text-muted-foreground">progress_activity</span>
      </div>
    }>
      {resetRequired ? <ResetRequiredPage info={resetRequired} /> : (
      <Router history={hashHistory}>
        <Home path="/" />
        <Settings path="/settings" />
        <SettingsSection path="/settings/:section" />
        <Friends path="/friends" />
        <LinkDevicePage path="/link-device/:token" />
        <AddFriendPage path="/add-friend/:token" />
        <AllCalendars path="/calendars/" />
        {/* Ranked above the DocRoute wildcard below: preact-router scores a
            static segment higher than `:rest*`, regardless of JSX order. */}
        <SharingPage path="/d/:docId/share" />
        <DocRoute path="/d/:docId/:rest*" />
        <DocRoute path="/d/:docId" />
        <SourceViewer path="/source/:docId/:rest*" />
        <SourceViewer path="/source/:docId" />
      </Router>
      )}
    </Suspense>
    </>
  );
}
