import Router from 'preact-router';
import { Home } from './home/Home';
import { Calendar } from './calendar/Calendar';
import { AllCalendars } from './calendar/AllCalendars';
import { Tasks } from './tasks/Tasks';
import { SourceViewer } from './source/SourceViewer';
import { DataGrid } from './datagrid/DataGrid';
import { Settings } from './settings/Settings';
import { Contacts } from './contacts/Contacts';
import { LinkDevicePage } from './settings/LinkDevicePage';
import { LinkDeviceSharePage } from './settings/LinkDeviceSharePage';
import { AddFriendPage } from './settings/AddFriendPage';
import { ShareWithFriendPage } from './settings/ShareWithFriendPage';
import { hashHistory } from './hash-history';
import { UpdateBanner } from './components/UpdateBanner';
import { WorkerErrorBanner } from './components/WorkerErrorBanner';
import { Toaster } from './components/ui/toast';
import { Theme } from '@radix-ui/themes';
export function App() {
  return (
    <Theme appearance="light" accentColor="blue" grayColor="gray" radius="medium">
    <WorkerErrorBanner />
    <UpdateBanner />
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
      <Calendar path="/calendars/:docId/:rest*" />
      <Calendar path="/calendars/:docId" />
      <Calendar path="/view/calendars/:docId/:rest*" readOnly />
      <Calendar path="/view/calendars/:docId" readOnly />
      <Tasks path="/tasks/:docId/:rest*" />
      <Tasks path="/tasks/:docId" />
      <Tasks path="/view/tasks/:docId/:rest*" readOnly />
      <Tasks path="/view/tasks/:docId" readOnly />
      <DataGrid path="/datagrids/:docId/sheets/:sheetId/:rest*" />
      <DataGrid path="/datagrids/:docId" />
      <DataGrid path="/view/datagrids/:docId/sheets/:sheetId/:rest*" readOnly />
      <DataGrid path="/view/datagrids/:docId" readOnly />
      <SourceViewer path="/source/:docId/:rest*" />
      <SourceViewer path="/source/:docId" />
    </Router>
    </Theme>
  );
}
