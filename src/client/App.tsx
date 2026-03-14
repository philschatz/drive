import Router from 'preact-router';
import { Home } from './home/Home';
import { Calendar } from './calendar/Calendar';
import { AllCalendars } from './calendar/AllCalendars';
import { Tasks } from './tasks/Tasks';
import { SourceViewer } from './source/SourceViewer';
import { DataGrid } from './datagrid/DataGrid';
import { Settings } from './settings/Settings';
import { InvitePage } from './invite/InvitePage';
import { hashHistory } from './hash-history';
export function App() {
  return (
    <Router history={hashHistory}>
      <Home path="/" />
      <Settings path="/settings" />
      <InvitePage path="/invite/:docId/:docType/:inviteKey" />
      <InvitePage path="/invite/:docId/:inviteKey" />
      <AllCalendars path="/calendars/" />
      <Calendar path="/calendars/:docId" />
      <Calendar path="/view/calendars/:docId" readOnly />
      <Tasks path="/tasks/:docId" />
      <Tasks path="/view/tasks/:docId" readOnly />
      <DataGrid path="/datagrids/:docId/sheets/:sheetId" />
      <DataGrid path="/datagrids/:docId" />
      <DataGrid path="/view/datagrids/:docId/sheets/:sheetId" readOnly />
      <DataGrid path="/view/datagrids/:docId" readOnly />
      <SourceViewer path="/source/:docId/:rest*" />
      <SourceViewer path="/source/:docId" />
    </Router>
  );
}
