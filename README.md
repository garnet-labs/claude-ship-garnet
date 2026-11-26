# Garnet build test canary

This private package is a fixture for Garnet's dependency-bump exhibit,
not a production dependency. Version 1.0.0 provides a build label and
does not make network requests. Version 1.0.1 adds one HTTPS HEAD to
`https://example.com/` when imported. It sends no build data, does not
follow redirects, and does not require the request to succeed.
