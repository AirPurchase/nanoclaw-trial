import { registerDeliveryAction } from '../../delivery.js';
import {
  handleRunCommand,
  handleStartProcess,
  handleStopProcess,
  handleRestartProcess,
  handleListProcesses,
  handleCaptureTerminal,
  handleWaitForOutput,
  handleGetProcessLogs,
  handleOpenDashboard,
} from './actions.js';

registerDeliveryAction('host_run_command', handleRunCommand);
registerDeliveryAction('host_start_process', handleStartProcess);
registerDeliveryAction('host_stop_process', handleStopProcess);
registerDeliveryAction('host_restart_process', handleRestartProcess);
registerDeliveryAction('host_list_processes', handleListProcesses);
registerDeliveryAction('host_capture_terminal', handleCaptureTerminal);
registerDeliveryAction('host_wait_for_output', handleWaitForOutput);
registerDeliveryAction('host_get_process_logs', handleGetProcessLogs);
registerDeliveryAction('host_open_dashboard', handleOpenDashboard);
