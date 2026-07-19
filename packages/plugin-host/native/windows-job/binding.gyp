{
  "targets": [{
    "target_name": "sheldon_job_object",
    "sources": ["src/job-object.cc"],
    "defines": ["NAPI_VERSION=8"],
    "conditions": [["OS=='win'", { "libraries": ["-lkernel32"] }]]
  }]
}
