import Router from 'preact-router';
import { Home } from './home/Home';
import { Calendar } from './calendar/Calendar';
import { AllCalendars } from './calendar/AllCalendars';
import { Tasks } from './tasks/Tasks';
import { SourceViewer } from './source/SourceViewer';
import { DataGrid } from './datagrid/DataGrid';
import { hashHistory } from './hash-history';

export function App() {
  return (
    <Router history={hashHistory}>
      <Home path="/" />
      <AllCalendars path="/calendars/" />
      <Calendar path="/calendars/:docId" />
      <Tasks path="/tasks/:docId" />
      <DataGrid path="/datagrids/:docId" />
      <SourceViewer path="/source/:docId/:rest*" />
      <SourceViewer path="/source/:docId" />
    </Router>
  );
}
