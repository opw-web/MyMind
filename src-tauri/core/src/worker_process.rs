use std::{ffi::OsString, path::Path};

use anyhow::Result;

#[cfg(windows)]
mod platform {
    use std::{
        ffi::{OsStr, OsString, c_void},
        io,
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
        ptr::{null, null_mut},
    };

    use anyhow::{Context, Result, ensure};
    use windows_sys::Win32::{
        Foundation::{HANDLE, WAIT_TIMEOUT},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{
                CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
                PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess,
                WaitForSingleObject,
            },
        },
    };

    pub struct ManagedProcess {
        _job: OwnedHandle,
        process: OwnedHandle,
        pid: u32,
    }

    fn quoted(value: &OsStr) -> Vec<u16> {
        let mut output = vec![b'"' as u16];
        let mut slashes = 0;
        for unit in value.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            if unit == b'"' as u16 {
                slashes = slashes * 2 + 1;
            }
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes));
            slashes = 0;
            output.push(unit);
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
        output
    }

    pub fn spawn(
        executable: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
    ) -> Result<ManagedProcess> {
        let app = executable
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let mut command = quoted(executable.as_os_str());
        for argument in args {
            command.push(b' ' as u16);
            command.extend(quoted(argument));
        }
        command.push(0);
        let mut entries = std::env::vars_os().collect::<Vec<_>>();
        for (key, value) in env {
            entries.retain(|(existing, _)| {
                !existing
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&key.to_string_lossy())
            });
            entries.push((key.clone(), value.clone()));
        }
        entries.sort_by_cached_key(|(key, _)| key.to_string_lossy().to_uppercase());
        let mut environment = Vec::new();
        for (key, value) in entries {
            environment.extend(
                key.encode_wide()
                    .chain([b'=' as u16])
                    .chain(value.encode_wide())
                    .chain([0]),
            );
        }
        environment.push(0);
        unsafe {
            let job = CreateJobObjectW(null(), null());
            ensure!(
                !job.is_null(),
                "Could not create a worker process group: {}",
                io::Error::last_os_error()
            );
            let job = OwnedHandle::from_raw_handle(job);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error())
                    .context("Could not configure worker process cleanup.");
            }
            let startup = STARTUPINFOW {
                cb: size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut info = PROCESS_INFORMATION::default();
            if CreateProcessW(
                app.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast::<c_void>(),
                null(),
                &startup,
                &mut info,
            ) == 0
            {
                return Err(io::Error::last_os_error())
                    .context("Could not start the local worker.");
            }
            let process = OwnedHandle::from_raw_handle(info.hProcess);
            let thread = OwnedHandle::from_raw_handle(info.hThread);
            if AssignProcessToJobObject(
                job.as_raw_handle() as HANDLE,
                process.as_raw_handle() as HANDLE,
            ) == 0
            {
                let error = io::Error::last_os_error();
                TerminateProcess(process.as_raw_handle() as HANDLE, 1);
                return Err(error).context("Could not attach the worker to its cleanup group.");
            }
            if ResumeThread(thread.as_raw_handle() as HANDLE) == u32::MAX {
                return Err(io::Error::last_os_error())
                    .context("Could not resume the local worker.");
            }
            Ok(ManagedProcess {
                _job: job,
                process,
                pid: info.dwProcessId,
            })
        }
    }

    impl ManagedProcess {
        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn alive(&mut self) -> bool {
            unsafe {
                WaitForSingleObject(self.process.as_raw_handle() as HANDLE, 0) == WAIT_TIMEOUT
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use anyhow::Result;
    use std::{
        ffi::OsString,
        path::Path,
        process::{Child, Command, Stdio},
    };

    pub struct ManagedProcess(Child);

    pub fn spawn(
        executable: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
    ) -> Result<ManagedProcess> {
        Ok(ManagedProcess(
            Command::new(executable)
                .args(args)
                .envs(env.iter().map(|(key, value)| (key, value)))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        ))
    }

    impl ManagedProcess {
        pub fn pid(&self) -> u32 {
            self.0.id()
        }

        pub fn alive(&mut self) -> bool {
            matches!(self.0.try_wait(), Ok(None))
        }
    }

    impl Drop for ManagedProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

pub use platform::ManagedProcess;

pub fn spawn(
    executable: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
) -> Result<ManagedProcess> {
    platform::spawn(executable, args, env)
}
