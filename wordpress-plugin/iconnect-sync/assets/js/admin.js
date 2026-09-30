(function ($) {
    'use strict';

    $(document).ready(function () {
        var $button = $('#iconnect-sync-now');
        var $result = $('#iconnect-sync-result');

        $button.on('click', function () {
            $button.prop('disabled', true).text(iconnectSync.syncing);
            $result.text('').removeClass('success error');

            $.ajax({
                url: iconnectSync.ajaxUrl,
                type: 'POST',
                data: {
                    action: 'iconnect_sync_now',
                    nonce: iconnectSync.nonce
                },
                success: function (response) {
                    if (response.success) {
                        var data = response.data;
                        var msg = 'Sync complete: ' + data.created + ' created, ' + data.updated + ' updated, ' + data.trashed + ' trashed.';
                        $result.text(msg).addClass('success');
                    } else {
                        $result.text('Error: ' + response.data).addClass('error');
                    }
                },
                error: function () {
                    $result.text('Sync request failed.').addClass('error');
                },
                complete: function () {
                    $button.prop('disabled', false).text(iconnectSync.done);
                }
            });
        });
    });
})(jQuery);
