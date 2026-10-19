package devices_test

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"net"
	"net/netip"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func TestDeviceTLSHostnamePreservesFrozenDNSMatching(t *testing.T) {
	cases := []struct {
		name     string
		identity string
		hostname string
		match    bool
	}{
		{"ASCII case", "Main.Example.COM", "main.example.com", true},
		{"reference trailing dot", "main.example.com", "main.example.com.", false},
		{"matching trailing dots", "main.example.com.", "main.example.com.", true},
		{"whole wildcard", "*.example.com", "a.example.com", true},
		{"wildcard cannot cross labels", "*.example.com", "a.b.example.com", false},
		{"wildcard needs a label", "*.example.com", "example.com", false},
		{"wildcard excludes underscore", "*.example.com", "a_b.example.com", false},
		{"literal wildcard identity", "*.example.com", "*.example.com", true},
		{"whole wildcard permits A-label", "*.example.com", "xn--abc.example.com", true},
		{"partial suffix wildcard", "w*.example.com", "www.example.com", true},
		{"partial suffix matches empty", "w*.example.com", "w.example.com", true},
		{"partial prefix matches empty", "*w.example.com", "w.example.com", true},
		{"middle wildcard rejected", "w*w.example.com", "www.example.com", false},
		{"wildcard cannot cover top level", "*.com", "example.com", false},
		{"invalid wildcard still literal", "*.com", "*.com", true},
		{"A-label wildcard pattern", "xn--*.example.com", "xn--abc.example.com", false},
		{"partial wildcard cannot cover A-label", "*abc.example.com", "xn--abc.example.com", false},
		{"later label wildcard", "a.*.example.com", "a.b.example.com", false},
		{"wildcard with trailing dot", "*.example.com.", "a.example.com.", false},
		{"wildcard with trailing hyphen", "*.example-.com", "a.example-.com", false},
		{"wildcard after hyphen", "a-*.example.com", "a-b.example.com", false},
		{"subdomain reference", "main.example.com", ".example.com", true},
		{"subdomain reference spans labels", "a.b.example.com", ".example.com", true},
		{"subdomain reference wildcard", "*.example.com", ".example.com", true},
		{"subdomain reference excludes apex", "example.com", ".example.com", false},
		{"subdomain exact literal", ".example.com", ".example.com", true},
		{"root dot is not suffix search", "main.example.", ".", false},
		{"root dot literal", ".", ".", true},
		{"NUL certificate name", "bad\x00.example.com", ".example.com", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSFixture(t, func(certificate *x509.Certificate) {
				certificate.DNSNames = []string{test.identity}
			})
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, test.hostname)
			if test.match {
				if err != nil {
					t.Fatalf("matching advertised host rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSHostMismatch) || err.Error() != "The approved device TLS certificate does not match its public endpoint." {
				t.Fatalf("mismatched advertised host result = %v", err)
			}
		})
	}
}

func TestDeviceTLSHostnameUsesDNSNamesBeforeSubjectFallback(t *testing.T) {
	cases := []struct {
		name      string
		customize func(*x509.Certificate)
		hostname  string
		match     bool
	}{
		{name: "subject without DNS SAN", hostname: "main.example.com", match: true, customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = nil
		}},
		{name: "DNS SAN suppresses subject", hostname: "main.example.com", customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = []string{"other.example.com"}
		}},
		{name: "IP SAN permits DNS subject fallback", hostname: "main.example.com", match: true, customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = nil
			certificate.IPAddresses = []net.IP{net.ParseIP("192.0.2.1")}
		}},
		{name: "email SAN permits DNS subject fallback", hostname: "main.example.com", match: true, customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = nil
			certificate.EmailAddresses = []string{"worker@example.com"}
		}},
		{name: "first of multiple subject CNs", hostname: "first.example.com", match: true, customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = nil
			certificate.Subject = pkix.Name{ExtraNames: []pkix.AttributeTypeAndValue{
				{Type: asn1.ObjectIdentifier{2, 5, 4, 3}, Value: "first.example.com"},
				{Type: asn1.ObjectIdentifier{2, 5, 4, 3}, Value: "last.example.com"},
			}}
		}},
		{name: "later matching DNS SAN", hostname: "main.example.com", match: true, customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = []string{"other.example.com", "main.example.com"}
		}},
		{name: "numeric subject and DNS SAN cannot identify IP", hostname: "192.0.2.1", customize: func(certificate *x509.Certificate) {
			certificate.Subject.CommonName = "192.0.2.1"
			certificate.DNSNames = []string{"192.0.2.1"}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSFixture(t, test.customize)
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, test.hostname)
			if test.match {
				if err != nil {
					t.Fatalf("matching certificate identity rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSHostMismatch) {
				t.Fatalf("mismatched certificate identity result = %v", err)
			}
		})
	}
}

func TestDeviceTLSHostnamePreservesIPAddressFamilies(t *testing.T) {
	cases := []struct {
		name     string
		identity string
		hostname string
		match    bool
	}{
		{"IPv4", "192.0.2.1", "192.0.2.1", true},
		{"IPv4 mismatch", "192.0.2.1", "192.0.2.2", false},
		{"IPv4 is not mapped IPv6", "192.0.2.1", "::ffff:192.0.2.1", false},
		{"mapped IPv6", "::ffff:192.0.2.1", "::ffff:c000:201", true},
		{"mapped IPv6 is not IPv4", "::ffff:192.0.2.1", "192.0.2.1", false},
		{"IPv6 spelling", "2001:db8::1", "2001:0db8:0:0:0:0:0:1", true},
		{"IPv6 mismatch", "2001:db8::1", "2001:db8::2", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSFixture(t, func(certificate *x509.Certificate) {
				certificate.DNSNames = nil
				// Retain the original SAN width even for mapped IPv6; the Go
				// certificate writer's IP convenience field normalizes to IPv4.
				value, err := asn1.Marshal([]asn1.RawValue{{Class: 2, Tag: 7, Bytes: netip.MustParseAddr(test.identity).AsSlice()}})
				if err != nil {
					t.Fatal(err)
				}
				certificate.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 17}, Value: value}}
			})
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, test.hostname)
			if test.match {
				if err != nil {
					t.Fatalf("matching IP identity rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSHostMismatch) {
				t.Fatalf("mismatched IP identity result = %v", err)
			}
		})
	}
}
