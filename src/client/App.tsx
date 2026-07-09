import { HashRouter, Routes, Route } from 'react-router-dom';
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
import { UpdateBanner } from './components/UpdateBanner';
import { WorkerErrorBanner } from './components/WorkerErrorBanner';
import { Toaster } from './components/ui/toast';
export function App() {
  return (
    <>
    <WorkerErrorBanner />
    <UpdateBanner />
    <Toaster />
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/add-friend" element={<ShareWithFriendPage />} />
        <Route path="/link-device" element={<LinkDeviceSharePage />} />
        <Route path="/link-device/:cardData" element={<LinkDevicePage />} />
        <Route path="/add-friend/:cardData" element={<AddFriendPage />} />
        <Route path="/calendars" element={<AllCalendars />} />
        <Route path="/calendars/:docId/*" element={<Calendar />} />
        <Route path="/view/calendars/:docId/*" element={<Calendar readOnly />} />
        <Route path="/tasks/:docId/*" element={<Tasks />} />
        <Route path="/view/tasks/:docId/*" element={<Tasks readOnly />} />
        <Route path="/datagrids/:docId/sheets/:sheetId/*" element={<DataGrid />} />
        <Route path="/datagrids/:docId" element={<DataGrid />} />
        <Route path="/view/datagrids/:docId/sheets/:sheetId/*" element={<DataGrid readOnly />} />
        <Route path="/view/datagrids/:docId" element={<DataGrid readOnly />} />
        <Route path="/source/:docId/*" element={<SourceViewer />} />
        <Route path="/source/:docId" element={<SourceViewer />} />
      </Routes>
    </HashRouter>
    </>
  );
}
