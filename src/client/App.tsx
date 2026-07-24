import Router from 'preact-router';
import { DocRoute } from './DocRoute';
import { Home } from './home/Home';
import { AllCalendars } from './calendar/AllCalendars';
import { SourceViewer } from './source/SourceViewer';
import { Settings } from './settings/Settings';
import { Contacts } from './contacts/Contacts';
import { LinkDevicePage } from './settings/LinkDevicePage';
import { LinkDeviceSharePage } from './settings/LinkDeviceSharePage';
import { AddFriendPage } from './settings/AddFriendPage';
import { ShareWithFriendPage } from './settings/ShareWithFriendPage';
import { hashHistory } from './hash-history';
import { Notifications } from './components/Notifications';
import { Toaster } from './components/ui/toast';
export function App() {
  return (
    <>
    <Notifications />
    <Toaster />
    <Router history={hashHistory}>
      <Home path="/" />
      <Settings path="/settings" />
      <Contacts path="/contacts" />
      <ShareWithFriendPage path="/add-friend" />
      <LinkDeviceSharePage path="/link-device" />
      <LinkDevicePage path="/link-device/:cardData" />
      <AddFriendPage path="/add-friend/:cardData" />
      <AllCalendars path="/calendars/" />
      <DocRoute path="/d/:docId/:rest*" />
      <DocRoute path="/d/:docId" />
      <SourceViewer path="/source/:docId/:rest*" />
      <SourceViewer path="/source/:docId" />
    </Router>
    </>
  );
}
