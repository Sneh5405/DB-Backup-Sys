import path from 'path';

/**
 * Translates a daily/hourly simple cron expression to Windows XML trigger format.
 * Defaults to daily at 02:00 AM if complex cron is supplied.
 */
function parseCronForWindows(cronExpr: string): { type: string; details: string; startHour: string } {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const pad = (v: string) => v.padStart(2, '0');
    
    // Parse numeric hours and minutes if simple
    const h = isNaN(Number(hour)) ? '02' : pad(hour);
    const m = isNaN(Number(minute)) ? '00' : pad(minute);
    
    if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      return {
        type: 'Daily',
        details: '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
        startHour: `${h}:${m}:00`,
      };
    }
  }
  
  return {
    type: 'Daily',
    details: '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    startHour: '02:00:00',
  };
}

/**
 * Generates Windows Task Scheduler XML.
 */
export function generateWindowsXml(cronExpr: string, nodePath: string, scriptPath: string, args: string): string {
  const { details, startHour } = parseCronForWindows(cronExpr);
  const nowIsoDate = new Date().toISOString().split('T')[0];
  const absNodePath = path.resolve(nodePath);
  const absScriptPath = path.resolve(scriptPath);

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${nowIsoDate}T${startHour}</Date>
    <Author>DB-Backup-Sys</Author>
    <Description>Auto-generated database backup scheduler task.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${nowIsoDate}T${startHour}</StartBoundary>
      <Enabled>true</Enabled>
      ${details}
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${absNodePath}"</Command>
      <Arguments>"${absScriptPath}" ${args}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Translates a cron expression to a systemd OnCalendar format.
 */
function translateCronToSystemd(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const formatPart = (val: string) => val === '*' ? '*' : val;
    
    // Simplistic systemd timer translation
    // e.g. "0 2 * * *" -> "*-*-* 02:00:00"
    const dow = dayOfWeek === '*' ? '' : `${dayOfWeek} `;
    const date = (dayOfMonth === '*' && month === '*') ? '*-*-*' : `*-${formatPart(month)}-${formatPart(dayOfMonth)}`;
    const time = `${hour === '*' ? '*' : hour.padStart(2, '0')}:${minute === '*' ? '*' : minute.padStart(2, '0')}:00`;
    
    return `${dow}${date} ${time}`;
  }
  return '*-*-* 02:00:00';
}

/**
 * Generates systemd service file content.
 */
export function generateSystemdService(workingDir: string, nodePath: string, scriptPath: string, args: string, user: string = 'root'): string {
  const absWorkingDir = path.resolve(workingDir);
  const absNodePath = path.resolve(nodePath);
  const absScriptPath = path.resolve(scriptPath);

  return `[Unit]
Description=Database Backup Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${absWorkingDir}
ExecStart="${absNodePath}" "${absScriptPath}" ${args}
Restart=on-failure
User=${user}

[Install]
WantedBy=multi-user.target`;
}

/**
 * Generates systemd timer file content.
 */
export function generateSystemdTimer(cronExpr: string): string {
  const onCalendar = translateCronToSystemd(cronExpr);

  return `[Unit]
Description=Timer to trigger Database Backup Service

[Timer]
OnCalendar=${onCalendar}
Persistent=true

[Install]
WantedBy=timers.target`;
}
