import { registerRootComponent } from 'expo';
import { installDiagnostics, reportDiagnostic, reportDiagnosticError } from './src/diagnostics';

installDiagnostics();
reportDiagnostic('app_import_start');
try {
  // A static import would evaluate App before the diagnostic handler is installed.
  const App = require('./App').default;
  reportDiagnostic('app_import_ready');
  registerRootComponent(App);
} catch (error) {
  reportDiagnosticError(error, 'app_import');
  throw error;
}
