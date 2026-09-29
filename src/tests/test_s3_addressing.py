"""Virtual-hosted S3 addressing: bucket.endpoint instead of endpoint/bucket."""

from urllib.parse import urlparse

from db import _endpoint_flag_pairs
from s3_client import _create_s3_client
from security import virtual_hosted_for_endpoint


def _presigned_host(virtual_hosted):
    client = _create_s3_client(
        access_key='AKIATEST',
        secret_key='secretsecret',
        s3_base_url='https://s3.pt.cloud',
        region_name='us-east-1',
        ca_verify_path=None,
        skip_tls_verify=True,
        read_timeout=5,
        virtual_hosted=virtual_hosted,
    )
    url = client.generate_presigned_url(
        'get_object',
        Params={'Bucket': 'bucket1', 'Key': 'dir/a.txt'},
        ExpiresIn=60,
    )
    return urlparse(url)


def test_path_style_keeps_bucket_in_path():
    parsed = _presigned_host(False)
    assert parsed.netloc == 's3.pt.cloud'
    assert parsed.path.startswith('/bucket1/')


def test_style_follows_the_bucket_endpoint():
    group = {
        'endpoint_virtual_hosted': {
            'https://s3.pt.cloud': True,
            'https://s3-path.example': False,
        }
    }
    assert virtual_hosted_for_endpoint(group, 'https://s3.pt.cloud/') is True
    assert virtual_hosted_for_endpoint(group, 'https://s3-path.example') is False
    assert virtual_hosted_for_endpoint(group, 'https://other.example') is False


def test_endpoint_flags_stay_paired_with_urls():
    pairs = _endpoint_flag_pairs(
        ['https://s3.pt.cloud', 'https://s3-path.example'],
        None,
        [True, False],
    )
    assert pairs == [
        ('https://s3.pt.cloud', True),
        ('https://s3-path.example', False),
    ]


def test_virtual_hosted_puts_bucket_in_host():
    parsed = _presigned_host(True)
    assert parsed.netloc == 'bucket1.s3.pt.cloud'
    assert parsed.path.startswith('/dir/')
    assert '/bucket1/' not in parsed.path
