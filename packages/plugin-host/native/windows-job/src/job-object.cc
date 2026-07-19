#include <node_api.h>
#include <windows.h>

#include <cstdio>

namespace {

HANDLE process_job = nullptr;

napi_value ThrowWin32Error(napi_env env, const char* operation, DWORD error_code) {
  char code[32];
  char message[160];
  std::snprintf(code, sizeof(code), "WIN32_%lu", static_cast<unsigned long>(error_code));
  std::snprintf(message, sizeof(message), "%s failed with Win32 error %lu.", operation,
                static_cast<unsigned long>(error_code));
  napi_throw_error(env, code, message);
  return nullptr;
}

napi_value Initialize(napi_env env, napi_callback_info /* info */) {
  if (process_job != nullptr) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    return ThrowWin32Error(env, "CreateJobObjectW", GetLastError());
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    const DWORD error_code = GetLastError();
    CloseHandle(job);
    return ThrowWin32Error(env, "SetInformationJobObject", error_code);
  }

  if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
    const DWORD error_code = GetLastError();
    CloseHandle(job);
    return ThrowWin32Error(env, "AssignProcessToJobObject", error_code);
  }

  process_job = job;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 1, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
