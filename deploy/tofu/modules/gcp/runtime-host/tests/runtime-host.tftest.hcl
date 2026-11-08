mock_provider "google" {}

variables {
  claim_url  = "https://spyria.example.com/h/ABCDEFGHJKMNPQRS"
  host_image = "ghcr.io/camil-h/spyria-host:1.2.0"
  subnet_id  = "projects/project/regions/europe-west1/subnetworks/spyria"
  project    = "project"
}

run "the_host_dials_out_through_nat_with_its_claim_and_keeps_runtimes_off_the_metadata_server" {
  command = apply
  assert {
    condition     = length(google_compute_instance.host.network_interface[0].access_config) == 0
    error_message = "The host has no public address: it dials out through the control plane's NAT"
  }
  assert {
    condition     = strcontains(google_compute_instance.host.metadata["user-data"], "ghcr.io/camil-h/spyria-host:1.2.0 https://spyria.example.com/h/ABCDEFGHJKMNPQRS")
    error_message = "cloud-init starts the published host with its claim URL"
  }
  assert {
    condition     = strcontains(google_compute_instance.host.metadata["user-data"], "--dport 53 -j RETURN") && strcontains(google_compute_instance.host.metadata["user-data"], "169.254.0.0/16")
    error_message = "Runtimes keep DNS, which the metadata server answers on GCP, but never reach the metadata server otherwise"
  }
  assert {
    condition     = strcontains(google_compute_instance.host.metadata["user-data"], "until apt-get update") && strcontains(google_compute_instance.host.metadata["user-data"], "until docker pull ghcr.io/camil-h/spyria-host:1.2.0")
    error_message = "The first boot retries the install and the image pull until the network answers, since cloud-init runs it once"
  }
}

run "a_second_host_takes_its_own_name" {
  command = apply
  variables {
    host_name = "build-box"
  }
  assert {
    condition     = google_compute_instance.host.name == "spyria-build-box"
    error_message = "Each runtime host has its own resources"
  }
}
